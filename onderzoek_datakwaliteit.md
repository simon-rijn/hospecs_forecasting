# Onderzoeksdocument: Datakwaliteit en Databronnen — Lessen uit de PMS-exports

## Inleiding

Dit document beschrijft wat er is ontdekt over de brondata van dit project: de bezettingsexport (dagstaat) en de reserveringenexport, beide uit het PMS (Protel). Het gaat niet over de gebouwde pipeline, maar over de data zelf — voor iedereen die er zelf mee wil bouwen.

## De bezettingsexport (dagstaat)

### Het exportformaat is drie keer veranderd

- Eerst stond de datum als één tekstwaarde in een cel, later gesplitst in aparte weekdag- en datumkolommen, en daarna omgezet naar JSON via een externe conversiedienst (Cloudmersive).
- Elke wijziging is toegevoegd náast de vorige, niet vervangen — alle drie de formaten worden nog steeds herkend.

### De positie van gegevensrijen ligt niet vast

- Het aantal regels vóór de eerste echte datarij verschilt per bestand.
- Rijherkenning werkt daarom op basis van inhoud (weekdag- en datumpatroon), niet op een vaste positie.

### Getalnotatie kent meerdere lagen

- De export gebruikte eerst Nederlandse notatie (punt = duizendtal, komma = decimaal), later Amerikaanse notatie (komma = duizendtal, punt = decimaal).
- Het tussenliggende automatiseringsplatform (n8n) verwijdert in sommige gevallen zelf al de komma uit een waarde vóórdat de eigen verwerking deze ziet.
- Een getal met komma's en punten heeft dus niet één vaste betekenis — dat hangt af van het exportkanaal én de tussenstap.

### Samengevoegde cellen scheiden label en waarde — niet voor elke kolom

- Bij de conversie van het originele Excel-bestand naar JSON (via Cloudmersive) en de verdere verwerking door n8n, komt de merged-cell-structuur van het Excel-bestand terug in de kolomindeling van de JSON-data.
- Voor de kolom "Bezet" (kamernachten) staat het label daardoor één kolom los van de waarde.
- Voor andere kolommen ("extras", "Totaal") geldt die verschuiving niet — elke kolom moet dus apart worden gecontroleerd, niet worden afgeleid van een andere.

### Bestandsnaam-conventies variëren

- Schrijfwijze en hoofdlettergebruik van bestandsnamen kunnen verschillen.
- Bestandsherkenning moet hier ongevoelig voor zijn.

## De reserveringenexport

### De kolomvolgorde kan wisselen

- De kolomvolgorde van de reserveringenexport kan in de tijd verschuiven.
- Daarom herkent de verwerking kolommen op naam, niet op vaste positie.

### Elke reservering staat als twee rijen

- Elke reservering verschijnt als twee rijen: één anonieme placeholder-rij en één rij met de echte gastgegevens.
- Beide rijen hebben hetzelfde reserveringsnummer en dezelfde aanmaaktijd tot op de seconde.
- Gegevens zijn over de twee rijen verdeeld (bijvoorbeeld: annuleringsdatum op de ene, gastnaam op de andere) — een simpele telling van rijen geeft dus het dubbele aantal reserveringen.

### Statuscodes vragen interpretatie

- "CO" betekent bevestigd/actief, "VO" betekent geannuleerd — niet wat de letters zouden doen vermoeden.
- Er bestaan meer statuscodes dan de meest voorkomende, zoals "Opt" en "Temp".
- De annuleringsdatum is een stabieler signaal voor annulering dan de status zelf.

### Kanaalnamen variëren in schrijfwijze

- Dezelfde boekingsbron kan in de export op meer dan één manier geschreven staan.

### Reserveringsdata dekt niet de volledige werkelijke bezetting

- De reserveringenlijst geeft geen volledig beeld van de daadwerkelijke bezetting: groepsboekingen en walk-ins staan niet altijd als losse regel in dit bestand.
- Uit vergelijking met de bezettingsexport bleek de reserveringendata slechts zo'n 30 tot 60% van de werkelijke bezetting te dekken.
- Reserveringsdata is dus vooral geschikt voor verhoudingen en segmentatie, niet als absolute bron voor het totale gastenvolume — daarvoor is de bezettingsexport betrouwbaarder.

## Tijd, datums en tijdzones

- De eerste datum in een bestand komt niet per se overeen met de dag waarop het bestand is gegenereerd.
- Aanmaaktijdstempels bevatten een echt tijdscomponent, niet alleen een datum — dat telt mee bij berekeningen zoals boekingsvoorsprong.
- Datums die via n8n lopen, worden genormaliseerd naar UTC-middernacht; in de zomertijd kan dat een vergelijking op basis van lokale tijd een dag laten verschuiven.
- Sommige exportbestanden bevatten een vergelijkingsjaar-sectie (zelfde dag/maand, ander jaar) — een controle op een plausibel jaartal voorkomt verkeerde toewijzing.
- Historische data heeft een praktische startgrens; hoe ver terug een berekening kan kijken, hangt af van hoe lang de dataverzameling al loopt.

## Samenvattende observatie

Brondata is voortdurend in beweging: formaten, kolomvolgordes, notaties en de betekenis van codes kunnen wijzigen naarmate het PMS of de export zelf verandert. De praktische les: herken data op inhoud in plaats van op vaste positie, verifieer periodiek tegen een actueel exportbestand, en behandel stilzwijgend gebruik van een standaardwaarde als iets om te loggen.
