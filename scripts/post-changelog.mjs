#!/usr/bin/env node
/**
 * Holt den Islandking-Changelog (öffentlich, kein Login nötig) und postet
 * neue Einträge in einen Discord-Channel per Bot.
 *
 * Funktionsweise:
 *  1. Hauptseite laden -> aktuellen Haupt-JS-Bundle-Namen finden
 *  2. Haupt-Bundle laden -> darin den Import-Pfad des Changelog-Chunks finden
 *     (der Dateiname enthält einen Build-Hash, der sich bei jedem Deploy ändert)
 *  3. Changelog-Chunk laden -> das eingebettete Datenarray extrahieren
 *  4. Mit dem gespeicherten Stand (state/posted.json) vergleichen
 *  5. Neue Einträge (ältester zuerst) als Discord-Embeds posten
 *  6. Bei bereits bekannten Einträgen: neu hinzugekommene Punkte als
 *     separates "Ergänzung"-Embed posten
 *  7. Neuen Stand speichern (wird von der GitHub Action zurückcommittet)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import vm from "node:vm";
import path from "node:path";

const BASE_URL = "https://islandking.ch";
const STATE_PATH = path.join(process.cwd(), "state", "posted.json");

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

if (!DISCORD_BOT_TOKEN || !DISCORD_CHANNEL_ID) {
  console.error("Fehler: DISCORD_BOT_TOKEN und DISCORD_CHANNEL_ID müssen als Umgebungsvariablen gesetzt sein.");
  process.exit(1);
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; IslandkingChangelogBot/1.0)" } });
  if (!res.ok) {
    throw new Error(`Fehler beim Abruf von ${url}: HTTP ${res.status}`);
  }
  return res.text();
}

async function getChangelogChunkUrl() {
  const html = await fetchText(`${BASE_URL}/`);
  const mainMatch = html.match(/src="(\/assets\/index-[\w.-]+\.js)"/);
  if (!mainMatch) {
    throw new Error("Haupt-JS-Bundle nicht gefunden. Hat sich der Seitenaufbau geändert?");
  }

  const mainJs = await fetchText(`${BASE_URL}${mainMatch[1]}`);
  const chunkMatch = mainJs.match(/import\("\.\/(ChangelogView-[\w.-]+\.js)"\)/);
  if (!chunkMatch) {
    throw new Error("Changelog-Chunk-Referenz nicht gefunden. Hat sich der Seitenaufbau geändert?");
  }

  return `${BASE_URL}/assets/${chunkMatch[1]}`;
}

/** Extrahiert das '[{date:...}, ...]'-Array-Literal aus dem minifizierten JS-Quelltext. */
function extractArrayLiteral(src) {
  const startMatch = src.match(/\[\{date:/);
  if (!startMatch) {
    throw new Error("Datenarray im Changelog-Chunk nicht gefunden. Hat sich das Datenformat geändert?");
  }
  const start = startMatch.index;

  let depth = 0;
  let quote = null;
  let esc = false;
  let end = -1;

  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === quote) quote = null;
    } else {
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
  }

  if (end === -1) {
    throw new Error("Ende des Datenarrays nicht gefunden (unausgeglichene Klammern?).");
  }

  return src.slice(start, end);
}

/** Wertet das extrahierte Array-Literal in einer leeren Sandbox aus (kein Zugriff auf Node-Globals). */
function parseEntries(arrayLiteral) {
  const context = vm.createContext({});
  const script = new vm.Script(`(${arrayLiteral})`);
  const result = script.runInContext(context, { timeout: 2000 });
  if (!Array.isArray(result)) {
    throw new Error("Geparste Daten sind kein Array.");
  }
  return result;
}

function entryId(entry) {
  return createHash("sha256").update(`${entry.date}::${entry.title}`).digest("hex");
}

/**
 * State-Format: { [id]: items[] }. Ältere Läufe schrieben ein reines Array
 * von IDs (ohne items) - wird beim Laden transparent migriert; für diese
 * IDs gibt es dann noch keine Baseline zum Diffen, das holt der nächste Lauf nach.
 */
async function loadKnownEntries() {
  try {
    const raw = await readFile(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { known: new Map(parsed.map((id) => [id, null])), isFirstRun: false };
    }
    return { known: new Map(Object.entries(parsed)), isFirstRun: false };
  } catch (err) {
    if (err.code === "ENOENT") return { known: null, isFirstRun: true };
    throw err;
  }
}

async function saveKnownEntries(known) {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  const obj = Object.fromEntries(known);
  await writeFile(STATE_PATH, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

async function postToDiscord(embed) {
  const res = await fetch(`https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord-API-Fehler ${res.status}: ${body}`);
  }
}

function entryEmbed(entry) {
  const description = entry.items.map((i) => `• ${i}`).join("\n").slice(0, 4096);
  return {
    title: entry.title.slice(0, 256),
    description,
    footer: { text: entry.date },
    color: 0x0a3a5b,
  };
}

function supplementEmbed(entry, addedItems) {
  const description = addedItems.map((i) => `• ${i}`).join("\n").slice(0, 4096);
  return {
    title: `Ergänzung: ${entry.title}`.slice(0, 256),
    description,
    footer: { text: entry.date },
    color: 0xb8860b,
  };
}

async function main() {
  const chunkUrl = await getChangelogChunkUrl();
  console.log(`Changelog-Chunk gefunden: ${chunkUrl}`);

  const chunkSrc = await fetchText(chunkUrl);
  const arrayLiteral = extractArrayLiteral(chunkSrc);
  const entries = parseEntries(arrayLiteral);
  console.log(`${entries.length} Einträge im Changelog gefunden.`);

  const { known, isFirstRun } = await loadKnownEntries();

  if (isFirstRun) {
    const initial = new Map(entries.map((e) => [entryId(e), e.items]));
    await saveKnownEntries(initial);
    console.log(`Erster Lauf: ${entries.length} bestehende Einträge als bekannt markiert, nichts gepostet.`);
    return;
  }

  const newEntries = [];
  const changedEntries = []; // { entry, addedItems }

  for (const entry of entries) {
    const id = entryId(entry);
    if (!known.has(id)) {
      newEntries.push(entry);
      continue;
    }
    const oldItems = known.get(id);
    if (oldItems === null) continue; // migrierte Alt-ID ohne Baseline, nichts zu vergleichen
    const addedItems = entry.items.filter((i) => !oldItems.includes(i));
    if (addedItems.length > 0) {
      changedEntries.push({ entry, addedItems });
    }
  }

  if (newEntries.length === 0 && changedEntries.length === 0) {
    console.log("Keine neuen oder geänderten Einträge.");
    return;
  }

  newEntries.reverse();
  changedEntries.reverse();

  for (const entry of newEntries) {
    await postToDiscord(entryEmbed(entry));
    console.log(`Gepostet: ${entry.title}`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  for (const { entry, addedItems } of changedEntries) {
    await postToDiscord(supplementEmbed(entry, addedItems));
    console.log(`Ergänzung gepostet: ${entry.title} (+${addedItems.length})`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  const updated = new Map(entries.map((e) => [entryId(e), e.items]));
  await saveKnownEntries(updated);
}

main().catch((err) => {
  console.error("Fehlgeschlagen:", err);
  process.exit(1);
});
