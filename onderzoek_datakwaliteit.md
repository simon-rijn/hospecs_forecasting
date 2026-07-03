# Onderzoeksdocument: Datakwaliteit en Databronnen — Lessen uit de PMS-exports

## Inleiding

Dit document beschrijft wat er is ontdekt over de brondata van dit project: de bezettingsexport (dagstaat) en de reserveringenexport, beide uit het PMS (Protel). Het gaat niet over de gebouwde pipeline, maar over de data zelf — voor iedereen die er zelf mee wil bouwen.

## De bezettingsexport (dagstaat)

### Het exportformaat is drie keer veranderd

Eerst stond de datum als één tekstwaarde in een cel. Later werd dit gesplitst in aparte weekdag- en datumkolommen, en daarna werd het bestand omgezet naar JSON via een externe conversiedienst (Cloudmersive). Elke wijziging is toegevoegd náast de vorige in plaats van die te vervangen, waardoor alle drie de formaten nog steeds herkend worden.

### De positie van gegevensrijen ligt niet vast

Het aantal regels vóór de eerste echte datarij verschilt per bestand. Rijherkenning werkt daarom op basis van de inhoud van een rij — het weekdag- en datumpatroon — en niet op een vaste positie in het bestand.

### Getalnotatie kent meerdere lagen

De export gebruikte eerst de Nederlandse notatie (punt als duizendtal-scheiding, komma als decimaal), en later de Amerikaanse notatie (komma als duizendtal-scheiding, punt als decimaal). Daar komt bij dat het tussenliggende automatiseringsplatform (n8n) in sommige gevallen zelf al de komma uit een waarde verwijdert vóórdat de eigen verwerking deze te zien krijgt. Een getal met komma's en punten heeft dus niet één vaste betekenis; dat hangt af van zowel het exportkanaal als deze tussenstap.

### Samengevoegde cellen scheiden label en waarde — niet voor elke kolom

Bij de conversie van het originele Excel-bestand naar JSON (via Cloudmersive) en de verdere verwerking door n8n, komt de merged-cell-structuur van het Excel-bestand terug in de kolomindeling van de JSON-data. Voor de kolom "Bezet" (kamernachten) staat het label daardoor één kolom los van de waarde. Voor andere kolommen, zoals "extras" en "Totaal", geldt die verschuiving niet — elke kolom moet dus apart worden gecontroleerd, in plaats van te worden afgeleid van het gedrag van een andere kolom.

### Bestandsnaam-conventies variëren

De schrijfwijze en het hoofdlettergebruik van bestandsnamen kunnen verschillen. Bestandsherkenning die hierop steunt, doet er goed aan hier ongevoelig voor te zijn.

## De reserveringenexport

### De kolomvolgorde kan wisselen

De kolomvolgorde van de reserveringenexport kan in de tijd verschuiven. Om die reden herkent de verwerking kolommen op hun naam, niet op een vaste positie.

### Elke reservering staat als twee rijen

Elke reservering verschijnt in de export als twee rijen: één anonieme placeholder-rij en één rij met de echte gastgegevens. Beide rijen delen hetzelfde reserveringsnummer en exact dezelfde aanmaaktijd, tot op de seconde nauwkeurig. De gegevens zijn bovendien over de twee rijen verdeeld — de annuleringsdatum staat bijvoorbeeld op de ene rij, de gastnaam op de andere — waardoor een simpele telling van rijen het dubbele aantal reserveringen zou opleveren.

### Statuscodes vragen interpretatie

De code "CO" betekent bevestigd of actief, terwijl "VO" staat voor geannuleerd — niet wat de letters op het eerste gezicht zouden doen vermoeden. Daarnaast bestaan er meer statuscodes dan de meest voorkomende, zoals "Opt" en "Temp". De annuleringsdatum is een stabieler signaal voor annulering dan de status zelf.

### Kanaalnamen variëren in schrijfwijze

Dezelfde boekingsbron kan in de export op meer dan één manier geschreven staan.

## Tijd, datums en tijdzones

De eerste datum in een bestand komt niet per se overeen met de dag waarop het bestand is gegenereerd.

Aanmaaktijdstempels bevatten een echt tijdscomponent, niet alleen een datum, en dat component telt mee bij berekeningen zoals boekingsvoorsprong.

Datums die via n8n lopen, worden genormaliseerd naar UTC-middernacht. In de zomertijd kan dat een vergelijking op basis van lokale tijd een dag laten verschuiven.

Sommige exportbestanden bevatten een vergelijkingsjaar-sectie, met dezelfde dag en maand maar een ander jaar. Een controle op een plausibel jaartal voorkomt dat zulke waarden aan het verkeerde jaar worden toegeschreven.

Historische data heeft een praktische startgrens: hoe ver terug een berekening kan kijken, hangt af van hoe lang de dataverzameling al loopt.

## Samenvattende observatie

Brondata is voortdurend in beweging: formaten, kolomvolgordes, notaties en de betekenis van codes kunnen wijzigen naarmate het PMS of de export zelf verandert. De praktische les: herken data op inhoud in plaats van op vaste positie, verifieer periodiek tegen een actueel exportbestand, en behandel stilzwijgend gebruik van een standaardwaarde als iets om te loggen.
