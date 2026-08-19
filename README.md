# Islandking Changelog → Discord

Postet automatisch neue Einträge aus dem Islandking-Changelog
(https://islandking.ch/changelog) in einen Discord-Channel.

Kein islandking.ch-Login nötig – die Changelog-Seite ist eine öffentliche
Route, deren Inhalte direkt (unauthentifiziert) im JavaScript der Seite
enthalten sind. Das Skript liest sie von dort, ganz ohne Zugangsdaten.

## Einrichtung

### 1. Repo erstellen
Diesen Ordner in ein neues (privates oder öffentliches) GitHub-Repository hochladen.

### 2. Discord-Bot anlegen
1. https://discord.com/developers/applications → "New Application"
2. Im Menü "Bot" → "Add Bot"
3. Bot-Token kopieren (wird gleich als Secret gebraucht)
4. Im Menü "OAuth2" → "URL Generator": Scope `bot` ankreuzen, Berechtigungen
   `Send Messages` und `Embed Links` aktivieren, generierten Link öffnen und
   den Bot auf deinen Server einladen
5. Discord: Einstellungen → Erweitert → Entwicklermodus aktivieren, dann
   Rechtsklick auf den Ziel-Channel → "ID kopieren"

### 3. Secrets im Repo hinterlegen
Repo → Settings → Secrets and variables → Actions → "New repository secret":

| Name                 | Wert                          |
|----------------------|--------------------------------|
| `DISCORD_BOT_TOKEN`  | Bot-Token aus Schritt 2        |
| `DISCORD_CHANNEL_ID` | Channel-ID aus Schritt 2       |

### 4. Schreibrechte für Actions aktivieren
Repo → Settings → Actions → General → "Workflow permissions" →
**Read and write permissions** auswählen und speichern (nötig, damit der
Workflow `state/posted.json` zurückcommitten kann).

### 5. Ersten Lauf testen
Repo → Actions → "Islandking Changelog -> Discord" → "Run workflow"
(manueller Start über `workflow_dispatch`).

**Wichtig:** Beim allerersten Lauf werden alle aktuell vorhandenen Einträge
nur als "bekannt" gespeichert, aber **nicht** gepostet – sonst würde der
Channel sofort mit der kompletten Historie geflutet. Erst ab dem zweiten
Lauf werden wirklich neue Einträge gepostet.

## Ablauf danach
Der Workflow läuft automatisch alle 30 Minuten (anpassbar über den
`cron`-Ausdruck in `.github/workflows/changelog.yml`), prüft auf neue
Einträge und postet sie als Discord-Embed.

## Funktionsweise (kurz)
1. Hauptseite laden → Namen des aktuellen JS-Bundles finden
2. Darin den Import-Pfad des Changelog-Chunks finden (Dateiname ändert
   sich bei jedem Deploy der Seite)
3. Changelog-Chunk laden → eingebettetes Datenarray extrahieren
4. Mit `state/posted.json` vergleichen, neue Einträge ermitteln
5. Neue Einträge posten, `state/posted.json` aktualisieren und committen

## Falls sich die Seite grundlegend ändert
Ändert Islandking den Aufbau seiner Seite grundlegend (andere
Router-/Build-Struktur), kann die automatische Erkennung fehlschlagen. Der
Workflow-Lauf zeigt dann einen Fehler in den Actions-Logs – das Skript
postet in diesem Fall einfach nichts, statt falsche Daten zu senden.
