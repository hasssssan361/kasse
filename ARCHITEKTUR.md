# Technische Architektur

## Überblick

```
 Android-Gerät (Chrome, installierte App)
 ┌──────────────────────────────────────────────────────────────┐
 │  Oberfläche: Kasse (app/kasse) · Admin-Bereich (app/admin)     │
 │        │  Aufträge („POST /api/pos/items“ …)                  │
 │        ▼                                                       │
 │  Rechenkern im Hintergrund (Web Worker, app/shared/engine-worker.js)
 │        Kassenlogik, Rechte, Warnsystem, Protokoll (app/core)   │
 │        │  EINE Transaktion: Datenänderung + Audit-Eintrag      │
 │        ▼                                                       │
 │  SQLite (WebAssembly, app/vendor/sqlite) im privaten App-Speicher (OPFS)
 │        + Schutz-Trigger + Änderungsjournal + Hash-Kette        │
 └──────────────────────────────────────────────────────────────┘
 Service Worker (app/sw.js): hält alle Programmdateien vor → Start ohne Internet
```

- **Kein Server, keine Abhängigkeiten zur Laufzeit.** Einzige Fremdkomponente: offizielles SQLite-WebAssembly
  (`@sqlite.org/sqlite-wasm` 3.53.4, Apache-2.0 / SQLite Public Domain), mitgeliefert in `app/vendor/sqlite`.
- **Gleicher Programmcode in App und Tests:** `app/core` läuft im Browser (Treiber `wasm-driver.js`) und in Node
  für die automatischen Tests (Treiber `test/node-driver.js`).
- **Kryptografie** in reinem JavaScript (`app/core/crypto.js`): SHA-256 für die Hash-Kette, PBKDF2-SHA256 für PINs.
- **Eine Datenbank-Verbindung:** Die Datenbank kann nur von einem Fenster gleichzeitig genutzt werden; beim Wechsel
  Kasse ↔ Admin-Bereich wird sie übergeben.

## Warum das Protokoll nicht umgangen werden kann

1. Die Oberfläche protokolliert nicht selbst; der Rechenkern führt Änderung **und** Protokolleintrag in einer
   Datenbank-Transaktion aus – alles oder nichts.
2. **Trigger in der Datenbank** (`app/core/db.js`):
   - Protokoll, Rechnungen, Zahlungen, Stornos, Verschiebungen, Preisänderungen, Tagesabschlüsse u. a.: kein UPDATE,
     kein DELETE (Ausnahme: kontrollierte Löschung alter Abschlüsse, siehe unten).
   - Neuer Protokolleintrag nur mit fortlaufender Nummer, korrektem Vorgänger-Hash, gültigem SHA-256, nicht rückdatiert.
   - Rechnungsnummern lückenlos je Jahr, Rechnungen ebenfalls hash-verkettet.
   - Positionen: nie löschbar; Artikel, Ersteller, Zeitpunkt fest; Mengen nur steigend.
3. **Änderungsjournal:** Trigger schreiben jede Zeilenänderung der Kerntabellen mit Vorher/Nachher mit.
4. **Integritätsprüfung** (`verifyIntegrity` in `app/core/audit.js`): rechnet alle Hashes nach, findet Lücken,
   Rückdatierungen, veränderte Rechnungen, fehlende Trigger und Änderungen außerhalb der Software.

## Löschen alter Tagesabschlüsse

`deleteOldestClosing` in `app/core/manage.js`: nur Administrator, nur der älteste Abschluss, Bestätigung „LÖSCHEN“.
Gelöscht wird alles bis zur Ereignisnummer des Abschlusses (Präfix der Hash-Kette); abgeschlossene Tische des Zeitraums
werden entfernt, über den Abschluss offene Tische behalten ihren Stand. Endpunkt der gelöschten Kette (Ereignis-Nr.,
Hash, letzte Rechnungsnummer je Jahr, Journal-Position) wird in `purges` gespeichert – die Prüfung der verbleibenden
Kette und die Rechnungsnummerierung setzen dort an. Die Löschung wird als `CLOSING_DELETED` protokolliert.

## Datenmodell

| Bereich | Tabelle(n) |
|---|---|
| Mitarbeiter, Rollen, Sitzungen | `users`, `roles`, `sessions` |
| Artikel, Kategorien, Tische | `articles`, `categories`, `dining_tables` |
| Tischvorgänge, Positionen | `orders`, `order_items` (`lifecycle_id` = Artikel-ID über alle Verschiebungen hinweg) |
| Stornos, Verschiebungen, Preisänderungen | `cancellations`, `item_moves`, `price_changes` |
| Rechnungen, Zahlungen | `invoices`, `invoice_items`, `payments` |
| Protokoll, Admin-Eingriffe, Journal | `audit_log`, `admin_actions`, `db_journal` |
| Warnungen, Schichten, Tagesabschlüsse | `alerts`, `shifts`, `day_closings` |
| Lager, Anker, gelöschte Zeiträume, Einstellungen | `stock_movements`, `anchors`, `purges`, `settings` |

## Dateien

| Pfad | Inhalt |
|---|---|
| `app/` | **Die App** (wird auf den Webspeicher hochgeladen) |
| `app/core/` | Kassenlogik, Datenbank, Schutz, Auswertungen, Export (CSV/PDF), Schnittstelle `api.js` |
| `app/shared/` | Gemeinsame Oberflächen-Bausteine, Rechenkern `engine-worker.js` |
| `app/kasse/`, `app/admin/` | Kasse und Admin-Bereich |
| `app/sw.js` | Offline-Betrieb (erzeugt von `tools/build-sw.mjs`) |
| `test/` | Automatische Tests (Node) |
| `tools/` | `build-sw.mjs` (Offline-Liste), `serve.mjs` (Test am PC), `make-icons.mjs` (App-Symbol) |
