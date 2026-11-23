# Kasse – Anleitung

**Version 1.0.1**

Manipulationsgeschütztes Kassensystem als **App für ein Android-Tablet oder -Smartphone**.
Alles läuft **im Gerät**: kein Server, kein Laptop, kein Fernzugang, im Betrieb **kein Internet nötig**, **kostenlos**.

> Wie gewünscht sind **TSE, KassenSichV, GoBD und Belegausgabepflicht nicht umgesetzt**. Für den Einsatz
> gegenüber dem Finanzamt muss das System vorher steuerrechtlich und technisch geprüft bzw. ergänzt werden.

---

## 1. So funktioniert es

- Es wird immer mit **einem Gerät** gearbeitet. Auf diesem Gerät liegen Kasse, Datenbank, Protokoll und Admin-Bereich.
- Die App wird **einmal über einen Link installiert** (wie eine normale App mit Symbol auf dem Startbildschirm).
  Danach startet und arbeitet sie **ohne Internet**.
- Internet wird nur gebraucht für die Installation und für Updates.
- Die Daten verlassen das Gerät nie. Auf dem Webspeicher, von dem installiert wird, liegt nur das Programm – keine Kassendaten.

## 2. Installation (einmalig)

**Voraussetzung:** Android-Gerät mit aktuellem **Google Chrome**.

1. Den Installations-Link **https://hasssssan361.github.io/kasse/** in **Chrome** öffnen.
2. Chrome zeigt „**App installieren**“ an – antippen. Falls nicht: Menü ⋮ → „**App installieren**“
   (bei manchen Versionen „Zum Startbildschirm hinzufügen“).
3. Auf dem Startbildschirm erscheint das blaue Symbol **„Kasse“**. Ab jetzt nur noch darüber öffnen.
4. Beim ersten Start meldet man sich als Administrator an (Abschnitt 3) und legt Artikel, Tische und Mitarbeiter an.

**Empfehlungen für das Gerät**
- Bildschirmsperre am Ladegerät abschalten oder lang einstellen (Einstellungen → Display → Bildschirm-Timeout).
- **„App anpinnen“** einschalten (Einstellungen → Sicherheit), damit Mitarbeiter die Kasse nicht verlassen können.
- Chrome und die App **nicht** deinstallieren und **keine Websitedaten löschen** – dabei würden alle Kassendaten gelöscht.

## 3. Erste Einrichtung (neues Gerät)

Die Kasse wird **leer** ausgeliefert: keine Artikel, keine Tische, keine Mitarbeiter.

1. **Gerät freischalten:** Gerätekennung an den Anbieter schicken und den erhaltenen Freischaltcode eingeben (siehe „Funktionen im Überblick“).
2. **Ersteinrichtung:** Direkt danach eigene Zugangsdaten festlegen: Personalnummer, Name, PIN (6–12 Ziffern), PIN wiederholen.
   Das geht nur einmal. Später ist alles unter **Verwaltung → Benutzer** änderbar. Die PIN bitte gut merken.
3. Mit diesen Daten auf dem Anmeldebildschirm unten **„Admin-Bereich“** antippen und anmelden.
4. **Verwaltung:** am besten zuerst den **Tischplan**, dann Kategorien, Artikel und Benutzer (Mitarbeiter, Schichtleitung) anlegen.
   Läuft die Kasse schon auf einem anderen Gerät, lassen sich alle Einstellungen unter **„Gerät & Übertragung“** übernehmen.
5. **„Abmelden und zur Kasse“** – zurück zur Kasse.

## 4. Kasse (Mitarbeiter)

1. **Anmelden** mit Personalnummer und PIN. Nach 5 Minuten ohne Bedienung automatische Abmeldung (einstellbar).
2. **Tisch antippen** → Artikel antippen. Menge vorher über die Zifferntasten (z. B. `3`, dann *Cola*);
   über *Art.-Nr.* per Artikelnummer. Hat ein Artikel **Varianten** (z. B. Bacardi: Shot, Longdrink, Flasche),
   erscheint danach die Auswahl der Variante mit Preis.
3. **Position antippen** (blau markiert) für **+1**, **Storno** (Grund Pflicht; ab 20 € oder nach 10 Minuten
   Freigabe durch Schichtleitung/Admin), **Verschieben** (auf anderen Tisch), **Preis** (Grund + Freigabe).
4. **Tischwechsel**, **Übernehmen** (Tisch eines Kollegen), **Bezahlen** (alles oder Auswahl, Zahlungsart,
   optional Rabatt) → **digitale Rechnung** (kein Bondrucker), PDF speicherbar.
   **Mit EC zahlen:** Zahlungsart „EC-Karte“ wählen → „Mit EC zahlen“ → Sicherheitsabfrage **Ja / Nein**.
   Bei „Ja“ werden alle gewählten Artikel storniert und mit dem Vermerk **„Mit EC bezahlt“** festgehalten
   (getrennt von normalen Stornos, ohne Storno-Warnungen). Bei „Nein“ bleibt alles unverändert.
5. **Rechnungen** (oben): heutige Rechnungen, ggf. **Tisch wiedereröffnen** (Freigabe nötig; Originalrechnung bleibt,
   es entsteht eine Stornorechnung).
6. **☰ → Meine Schicht**: Schichtabrechnung ansehen und abschließen.

Eine Löschen-Taste gibt es nicht. Alles Eingegebene bleibt sichtbar – auch für den Mitarbeiter unter
„Verlauf an diesem Tisch“.

Auf dem Smartphone wechselt man oben zwischen **„Artikel“** und **„Bestellung“**; auf dem Tablet steht beides nebeneinander.

## 5. Admin-Bereich (Inhaber)

Über **„Admin-Bereich“** auf dem Anmeldebildschirm der Kasse – am selben Gerät.

| Bereich | Inhalt |
|---|---|
| **Live-Übersicht** | Umsatz, offene Tische mit allen Artikeln (auch stornierte/verschobene), letzte Aktivitäten, Stornos und Rechnungen von heute |
| **Warnungen** | Automatisch erkannte Auffälligkeiten (Hinweise, kein Beweis) – mit Notiz als „geprüft“ markierbar |
| **Aktivitätsprotokoll** | Jede Aktion mit Zeit, Mitarbeiter, Tisch, Artikel, Vorher/Nachher; Filter und Export (CSV/PDF) |
| **Artikel-Lebenslauf** | Komplette Geschichte eines Artikels vom ersten Tastendruck bis zur Rechnung |
| **Rechnungen, Stornierungen, Verschiebungen, Preisänderungen** | Eigene Listen, durchsuchbar, exportierbar. Unter Stornierungen gibt es den Reiter **„Mit EC bezahlt“** (EC-Zahlungen getrennt, mit Tagessumme) |
| **Mitarbeiter** | Kennzahlen pro Tag/Woche/Monat inkl. Stornoquote |
| **Umsatz & Abschlüsse** | Umsatz nach Zahlungsart/Kategorie/Uhrzeit/Artikel/MwSt, **Tagesabschluss**, Schichten |
| **Soll-Ist (Lager)** | Warenentnahmen buchen und mit Verkäufen vergleichen; Varianten werden einzeln gezählt, per EC bezahlte Artikel als eigene Spalte |
| **Verwaltung** | Artikel, Kategorien, **Tischplan**, Tische, Benutzer, Rechte, Einstellungen, **Gerät & Übertragung** (Lizenz, Stammdaten exportieren/einlesen) (jede Änderung protokolliert). Beim Anlegen eines Artikels: **„Hat dieser Artikel Varianten?“** → Ja → **„Wie viele Varianten?“** → je Variante Name und Preis |
| **Manipulationsschutz** | Prüft die komplette Hash-Kette und die Schutzregeln der Datenbank |

## 6. Tagesabschluss und Löschen

- Am Ende jeder Schicht im Admin-Bereich unter **Umsatz & Abschlüsse → „Tagesabschluss jetzt“**.
  Der Abschluss fasst alles seit dem letzten Abschluss unveränderbar zusammen.
- **Alle Abschlüsse und Einzelheiten bleiben gespeichert, bis sie manuell gelöscht werden.**
- **Löschen:** beim **ältesten** Abschluss „…mit allen Einzelheiten löschen“, zur Bestätigung **LÖSCHEN** eingeben.
  Gelöscht werden der Abschluss und alle Einzelheiten seines Zeitraums (Protokoll, Stornos, Verschiebungen,
  Rechnungen, abgeschlossene Tische). Tische, die über den Abschluss hinaus offen waren, behalten ihren Stand.
- Nur der Administrator kann löschen, nur der Reihe nach (ältester zuerst). **Dass** gelöscht wurde, von wem und
  wie viel, bleibt dauerhaft im Protokoll und unter „Manipulationsschutz → Gelöschte Zeiträume“ sichtbar.

## 7. Schutz und Grenzen

- Jede Aktion wird sofort gespeichert – Änderung und Protokolleintrag immer gemeinsam.
- Die **Datenbank selbst** verweigert Ändern und Löschen von Protokoll, Rechnungen, Stornos und Positionen
  (außer der kontrollierten Löschung alter Abschlüsse durch den Administrator).
- Jeder Protokolleintrag ist per **Hash-Kette** mit dem vorigen verbunden; Veränderungen fallen bei der Prüfung auf.

**Ehrlich gesagt:**
- Die Daten liegen **nur auf diesem einen Gerät**. Geht es verloren, wird es zurückgesetzt, werden die App-Daten
  in Android gelöscht oder die App deinstalliert, sind die Daten weg – das System bemerkt so einen Totalverlust
  nicht selbst, der Chef sieht ihn aber sofort (leere Kasse, Rechnungsnummern beginnen neu).
  Wie besprochen gibt es keine Datensicherung.
- Wer sich mit Android auskennt, könnte die App-Daten löschen. Bei Mitarbeitern ohne dieses Wissen und mit
  „App anpinnen“ ist das praktisch ausgeschlossen.
- Verkäufe, die **gar nicht eingetippt** werden, kann kein System erkennen – dafür gibt es die Soll-Ist-Kontrolle.

**Datenschutz (DSGVO):** Das System protokolliert das Verhalten der Mitarbeiter. Diese vorher schriftlich
informieren (Zweck, gespeicherte Daten, Löschung). Bei Betriebsrat ist dessen Zustimmung nötig. Keine Rechtsberatung.

## 8. Update installieren

Updates kommen **automatisch über die App** – nichts neu installieren, nichts deinstallieren.
**Alle Daten bleiben erhalten** (Verkäufe, Rechnungen, Stornos, Tagesabschlüsse, Protokoll, Mitarbeiter, Artikel, Tische).

Ab Version 1.0.1 geht es von selbst: Ist das Gerät mit dem Internet verbunden, sucht die App beim Öffnen,
beim Zurückholen in den Vordergrund und alle 30 Minuten nach Updates. Ist eins installiert, erscheint unten
**„Neue Version installiert – Jetzt neu laden“**. Antippen, fertig. Mit „Später“ geht es erst beim nächsten Start weiter.

Von Hand (z. B. wenn der Hinweis nicht kommt):
1. Gerät **mit dem Internet verbinden** (WLAN).
2. Die Kasse über das Symbol **„Kasse“** öffnen und ca. **10 Sekunden** warten.
3. Die App **ganz schließen**: Übersicht der geöffneten Apps öffnen (□-Taste oder vom unteren Rand nach oben
   wischen) und die Kasse wegwischen.
4. Die Kasse **erneut öffnen**.
5. **Prüfen:** Unten auf dem Anmeldebildschirm steht die Versionsnummer (z. B. **„Version 1.0.1“**),
   im Admin-Bereich links unten „App-Version …“.

Steht dort noch die alte Version: Schritte 2–4 wiederholen.

**Tipp:** Updates am besten außerhalb der Öffnungszeiten einspielen und vorher offene Tische abrechnen.
Nötig ist das nicht – offene Tische bleiben auch beim Update erhalten.

## Funktionen im Überblick (Version 1.0.1)

### Auslieferung, Freischaltung und Ersteinrichtung
- Die Kasse wird **leer** ausgeliefert (keine Artikel, Tische oder Mitarbeiter).
- **Freischaltung pro Gerät:** Beim ersten Start erscheint **„Gerät freischalten“** mit einer Gerätekennung. Diese an
  den Anbieter schicken („Kopieren“ oder „Senden …“), den erhaltenen Freischaltcode einfügen und „Freischalten“ tippen.
  - Der Code gilt nur für dieses eine Gerät; jedes weitere Gerät braucht einen eigenen Code.
  - Löscht man die App-Daten oder setzt das Gerät zurück, entsteht eine neue Kennung, und das Gerät muss neu freigeschaltet werden.
  - Eine Lizenz kann befristet sein („Gültig bis“). Nach Ablauf sperrt die Kasse, bis ein neuer Code eingegeben wird.
    Die Daten bleiben erhalten. Neuen Code eingeben: Verwaltung → „Gerät & Übertragung“.
- **Ersteinrichtung:** Direkt nach der Freischaltung einmalig die eigenen Admin-Zugangsdaten festlegen
  (Personalnummer, Name, PIN). Später ist alles unter Verwaltung → Benutzer änderbar.
- **Für den Anbieter:** Freischaltcodes entstehen mit dem Freischalt-Werkzeug im Ordner `kassen-lizenz`. Der Ordner liegt
  nur auf dem PC des Anbieters und wird niemals hochgeladen; Näheres steht in der LIESMICH.txt dort.

### Stammdaten auf weitere Geräte übertragen
Admin-Bereich → Verwaltung → **„Gerät & Übertragung“**:
1. Auf dem eingerichteten Gerät ein Übertragungs-Passwort vergeben → „Stammdaten exportieren“. Die Datei landet
   unter „Downloads“.
2. Die Datei z. B. per WhatsApp, E-Mail oder USB auf das andere Gerät bringen. Das Passwort getrennt mitteilen.
3. Auf dem anderen Gerät: Datei auswählen → Passwort → „Datei prüfen …“ → Vorschau → „1:1 übernehmen“.

Übertragen werden Kategorien, Artikel mit Varianten, Tische, Tischplan, Mitarbeiter mit PIN, Rollenrechte und
Einstellungen. Was in der Datei fehlt, wird auf dem Zielgerät **deaktiviert, nie gelöscht**. Belegte Tische und
das eigene Admin-Konto bleiben aktiv. Buchungen, Rechnungen und Protokoll bleiben auf jedem Gerät für sich; jedes
Gerät arbeitet eigenständig. Die Datei ist verschlüsselt, weil sie die PINs enthält.

### Tischplan
- **Admin-Bereich → Verwaltung → Tischplan:** oben Elemente hinzufügen:
  - Tische als ▭ Rechteck, ◻ Quadrat oder ◯ Kreis
  - **Tresen** mit Gastplätzen
  - **Eingang** (grün)
  - **Spielautomaten** (◻/▯, lila gestreift)
  - **Terrasse / Bereich** (gestrichelte Fläche)
- **Bedienung (auch mit dem Finger):** Objekt antippen und ziehen = verschieben, blauer Punkt = Größe ändern, leere
  Fläche ziehen = Ansicht verschieben, **− / +** = zoomen. Unten stehen Nummer, Plätze, Bezeichnung, Form,
  „Drehen 90°“, „Duplizieren“ und „Entfernen“.
- **Tresen:** Plätze an allen vier Seiten einstellbar („Plätze unten / rechts / oben / links“). Jeder Gastplatz ist
  an der Kasse buchbar wie ein Tisch.
- **Spielautomaten** haben eine Nummer (im „Bildschirm“) und sind an der Kasse wie ein Tisch buchbar.
- **Nummern:** Tische, Tresenplätze und Automaten werden gemeinsam fortlaufend nummeriert; neue Plätze bekommen die
  nächste freie Nummer. Einen Tresenplatz antippen, um seine Nummer zu ändern, oder „Alle Plätze fortlaufend
  nummerieren ab …“ nutzen. Jede Nummer darf nur einmal vorkommen.
- **Mehrere Bereiche:** „+ Bereich“ (z. B. „Terrasse“). Den aktiven Bereich noch einmal antippen, um ihn
  umzubenennen, seine Größe zu ändern oder ihn zu entfernen.
- **„Plan speichern“** legt fehlende Tische, Tresenplätze und Automaten automatisch an (protokolliert). Ein aus dem
  Plan entfernter Tisch bleibt bestehen und kann unter „Tische“ deaktiviert werden.
- **An der Kasse** wird der Plan gezeigt: freie Tische neutral, eigene grün, Tische von Kollegen gelb, jeweils mit
  offenem Betrag. Oben schaltet man zwischen **Plan** und **Liste** um.

### An der Kasse
- **Artikelsuche:** Im geöffneten Tisch oben „Artikel suchen …“ eintippen, z. B. „jager“ für Jägermeister.
  Gesucht wird in allen Kategorien; Groß-/Kleinschreibung und Umlaute sind egal. Auch Artikelnummern und
  Variantennamen werden gefunden. Mit ✕ wird die Suche geleert.
- **Gästename am Tisch:** Im geöffneten Tisch oben **„+ Name“** tippen, z. B. „Familie Yilmaz“, und speichern.
  - Der Name erscheint im Tisch, im Plan, in der Tischliste und in der Live-Übersicht des Admin-Bereichs.
  - Er gilt für die aktuelle Belegung und ist nach dem Abschluss des Tisches weg.
  - Ändern oder Entfernen über „✎ Name“. Jede Änderung wird protokolliert.
- **Varianten:** Beim Anlegen eines Artikels „Hat dieser Artikel Varianten?“ → Ja → „Wie viele Varianten?“ → je
  Variante Name und Preis (z. B. 2 cl / Longdrink / Flasche). An der Kasse erscheint dann die Auswahl der Variante;
  das Lager wird je Variante gezählt.
- **Mit EC zahlen:** Zahlungsart „EC-Karte“ → „Mit EC zahlen“ → Sicherheitsabfrage Ja/Nein. Die Artikel werden
  storniert und mit dem Vermerk „Mit EC bezahlt“ festgehalten (Admin-Bereich → Stornierungen → Reiter „Mit EC bezahlt“).

## 9. Bereitstellung des Installations-Links

**Installations-Link: https://hasssssan361.github.io/kasse/**

Die App liegt kostenlos auf GitHub Pages (Repository `hasssssan361/kasse`). Dort liegt nur das Programm –
**keine Kassendaten**; diese bleiben ausschließlich auf dem Gerät.

Updates: Bei jedem Hochladen auf den Zweig `main` führt GitHub automatisch alle Tests aus und veröffentlicht die App
nur, wenn alle bestehen. Das Gerät lädt das Update beim nächsten Öffnen mit Internet und nutzt es ab dem
darauffolgenden Start.

## 10. Für Entwickler

```powershell
npm test
```
```powershell
npm start
```

`npm test` prüft mit 17 automatischen Tests u. a. den Ablauf aus Anforderung 13, Rechte, Freigaben, EC-Zahlung, Varianten, das Update einer Datenbank der Vorversion, doppelte
Übermittlung, Wiedereröffnung, Warnsystem, Export, das Löschen alter Abschlüsse und **gezielte Manipulationsversuche
direkt an der Datenbank**. `npm start` stellt die App zum Ausprobieren am PC unter http://localhost:8080 bereit.
