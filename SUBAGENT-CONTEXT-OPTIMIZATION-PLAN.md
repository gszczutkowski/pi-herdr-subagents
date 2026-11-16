# Plan stabilizacji kontekstu i ograniczenia zużycia tokenów

## Status i źródła

**Status: implementacja lokalna i niezależny przegląd zakończone dla napraw cyklu życia, krótkich odpowiedzi i zwykłej publikacji kontekstu; całość NIE jest odebrana jako w pełni naprawiona.**

Bieżący backlog: [BACKLOG.md](BACKLOG.md). Dowody i granice: [test/REPAIR-VERIFICATION.md](test/REPAIR-VERIFICATION.md).

| Etap | Stan |
|---|---|
| 0 | Zmiany początkowe zachowane; baza `d226f33`; pozostaje zakres peer `~1.3.0`, Pi 1.5.0 ma tylko sprawdzoną kompatybilność wybranego podzbioru |
| 1 | Syntetyczne regresje natywnego serializera/selektora i benchmark są powtarzalne; rzeczywiste final-wire bajty i billing A/B niezweryfikowane |
| 2 | Wdrożone i sprawdzone; 50 zadań: 27 206 → 333 bajty (98,8% mniej dla odpowiedzi fixture'a) |
| 3 | Zwykły przepływ i receipt dedup wdrożone; automatyczna kompakcja wymaga bezpiecznego fallbacku i pozostaje zależnością od API hosta |
| 4 | Poprawka źródeł w osobnym `E:/Repositories/pi-provider-kiro`, niezależny przegląd zaakceptowany i 828/828 testów bez pominięć; brak instalacji globalnej, incydent granicy testowania opisany w raporcie |
| 5 | Walidowane ostrzeżenia per provider/model i diagnostyka bajtów JSON; brak gwarantowanego gate dla final-wire/full-delta — zależność od hosta/providera |
| 6 | Ograniczone wskazówki zbędnego odczytu i zwykłe projekcje; lazy loading katalogów/schematów oraz eksperyment billing A/B nie zostały wykonane |
| 7 | Główne `npm test`: 626/626 bez pominięć; live herdr zablokowane brakiem wymaganego środowiska |

Podstawa: [audyt API i tokenów](test/API-TOKEN-AUDIT.md) z 2026-11-15. Dokument uzupełnia [dotychczasowy plan napraw](SUBAGENT-REPAIR-PLAN.md), nie zastępuje jego otwartych punktów.

Zakres obejmuje trzy oddzielne obszary odpowiedzialności:

1. **To repozytorium:** publikacja kontekstu planu/checkpointów/recovery, odpowiedzi narzędzi, instrukcje, konfiguracja i testy.
2. **Provider Kiro:** normalizacja wiadomości na granicy historii i bieżącego żądania; osobna poprawka w źródłowym projekcie `pi-provider-kiro`.
3. **Pi/pi-ai:** dostęp do rzeczywiście serializowanego żądania, wyboru pełnej/przyrostowej kontynuacji i bezpiecznej reakcji przed wysłaniem. Jeżeli rozszerzenie nie ma potrzebnego publicznego API, wymagana będzie osobna zmiana hosta.

Potwierdzone są utrata możliwości przyrostowej kontynuacji przez tymczasowe projekcje oraz błąd walidacji Kiro. **Limit 1 MiB pozostaje hipotezą popartą pomiarami, nie udokumentowanym limitem wszystkich providerów.** Plan nie zakłada, że każdy HTTP 400 oznacza przepełnienie.

## Cele i ograniczenia

- Usunąć przyczynę ciągłego przesyłania pełnej historii w niezmienionym stanie.
- Zachować aktualny, dostępny dla modelu stan po kompakcji, wznowieniu i zmianie gałęzi.
- Zapobiegać wadliwym żądaniom Kiro oraz wykrywać nadmierny rozmiar transportowy niezależnie od tokenów.
- Ograniczyć zbędne odczyty planu, rozbudowane potwierdzenia i duplikowanie informacji.
- Nie osłabiać kontroli rewizji, uprawnień rodzica, custody, akceptacji wyników ani ochrony danych.
- Nie usuwać arbitralnie par wywołanie–wynik, podpisanych bloków rozumowania lub fragmentów historii.
- Nie dodawać tur modelu wyłącznie po to, aby ogłosić stan planu lub checkpoint.
- Nie obiecywać konkretnego rabatu cache ani procentu oszczędności na podstawie samej kwalifikacji do WebSocket delta.

## Kolejność i zależności

```text
0. Zabezpieczenie stanu i wybór wspieranych wersji
   └─ 1. Powtarzalne regresje i pomiary bazowe
      ├─ 2. Krótkie odpowiedzi narzędzi
      │  └─ 3. Stabilna publikacja kontekstu
      ├─ 4. Poprawka adaptera Kiro — osobny projekt
      └─ 5. Budżet bajtów i diagnostyka — możliwa zależność od Pi

2 + 3 ── 6. Ograniczenie instrukcji i zbędnych odczytów
3 + 4 + 5 + 6 ── 7. Weryfikacja całości i przygotowanie wydania
```

Etapy 4 i analiza możliwości API w etapie 5 mogą przebiegać równolegle z pracą w tym repozytorium. Każdy etap powinien mieć osobny commit lub małą serię commitów z regresjami. Nie łączyć naprawy transportu z dużym refaktorem schematów narzędzi.

## 0. Zabezpieczenie stanu i kontraktu wersji

- [x] Zachować istniejące niezacommitowane zmiany w `pi-extension/subagents/live-continuation.ts` i `test/live-continuation.test.ts`; nie resetować ani nie włączać ich przypadkiem do tej implementacji.
- [x] Ustalić bazę gałęzi implementacyjnej i relację do niedokończonych poprawek 6–10 z poprzedniego planu.
- [x] Sprawdzić różnice publicznego API między zależnościami projektu Pi 1.3.x a zainstalowanym CLI 1.5.0.
- [x] Przed zmianami harnessu przeczytać właściwą dokumentację SDK, rozszerzeń i przykłady w całości wraz z istotnymi odsyłaczami.
- [x] Wybrać i zapisać wspierany zakres wersji. Jeśli wymagane API istnieje dopiero w nowszym Pi, jawnie podnieść minimalną wersję, zamiast dodawać cichy fallback do wadliwej projekcji.

**Odbiór:** udokumentowana macierz wersji i możliwości hooków; wcześniejsze zmiany zachowane; brak niejawnego polegania na globalnym `node_modules` użytkownika.

## 1. Regresje i pomiary bazowe

**Miejsca:** `test/plan-context.test.ts`, `test/context-checkpoint.test.ts`, `test/context-protection.test.ts`, nowe testy kompatybilności żądań i benchmark kontekstu.

- [ ] Przenieść metodę diagnozy z `.git/diagnostics/` do powtarzalnych testów na syntetycznych fixture'ach. Nie kopiować prywatnej sesji, poświadczeń ani surowych requestów do repozytorium.
- [ ] Odtworzyć dwa kolejne żądania z niezmienionym planem/checkpointem przez natywny serializer i rzeczywisty mechanizm wyboru delta.
- [ ] Dodać warianty: brak planu, plan bez checkpointu, checkpoint, recovery, zmiana rewizji, wynik dziecka, kompakcja i reload.
- [ ] Przygotować minimalne przypadki Kiro: `user + plan`, `toolResult + plan`, kilka wiadomości użytkownika po błędach oraz różne kombinacje checkpoint/recovery.
- [ ] Mierzyć osobno: bajty pełnego body, bajty rzeczywistego wariantu transportowego, tokeny tekstowe, schematy, wyniki narzędzi i liczbę żądań.
- [ ] Przechwytywać żądania offline przed siecią; domyślnie blokować wszelkie połączenia i odświeżanie katalogów/poświadczeń.

**Odbiór:** testy odtwarzają problemy na aktualnym kodzie; działają w czystym checkoutcie bez historycznej sesji. Użycie wewnętrznego API adaptera jest ograniczone do jawnie wersjonowanego testu, nie kodu produkcyjnego.

## 2. Krótkie odpowiedzi narzędzi jako podstawowe źródło aktualizacji

**Miejsca:** `pi-extension/subagents/plan-tools.ts`, `context-checkpoint.ts`, testy plan-store/persistence i checkpointów.

- [x] `plan_update` ma zwracać zwięzłe potwierdzenie: `planId`, nową rewizję, identyfikatory i status zmienionych zadań oraz nowo utworzone identyfikatory kryteriów/dowodów/prób potrzebne do następnej operacji.
- [x] Nie zwracać całej historii wszystkich zadań przy każdej drobnej mutacji. Pełny stan nadal pozostaje zapisany i dostępny przez jawny odczyt szczegółów.
- [x] Zachować informację o konflikcie rewizji, ograniczeniach uprawnień i niepewności odzyskiwania; nie zastępować błędów pozornym sukcesem.
- [x] `context_checkpoint save` ma zwracać krótkie potwierdzenie zapisu i jego trwałości. `read` nadal udostępnia zapisane notatki.
- [x] Sprawdzić kompatybilność `details`, rendererów i istniejących odbiorców wyników; skrócenie treści dla modelu nie może przypadkiem usunąć danych potrzebnych UI.

**Odbiór:** komplet operacji planu da się wykonać bez odczytu całego snapshotu po każdej mutacji; wszystkie potrzebne identyfikatory są dostępne. Dla ustalonego fixture'a z 50 zadaniami potwierdzenie pojedynczej zmiany jest co najmniej 70% krótsze niż dotychczasowy snapshot. To cel strukturalny testu, nie deklaracja oszczędności całej sesji.

## 3. Stabilna publikacja planu, checkpointu i recovery

**Miejsca:** `plan-context.ts`, `context-checkpoint.ts`, `recovery-report.ts`, `index.ts`, powiązane testy branch/history/runtime.

### Preferowany kierunek

Nie doklejać od nowa tymczasowych wiadomości na końcu każdego żądania. Zwykłe mutacje przekazują aktualizację przez ich trwałe wyniki narzędzi. Dodatkowe informacje potrzebne po odtworzeniu stanu publikować raz, w stabilnej reprezentacji zgodnej z natywną historią Pi.

Konkretne publiczne API publikacji należy zatwierdzić w etapie 0. Nie zakładać, że przeniesienie mutowalnego tekstu do początku/system promptu rozwiązuje problem cache. Jeśli host nie pozwala bezpiecznie opublikować danych bez dodatkowej tury i zmiany wcześniej wysłanego prefiksu, zgłosić zależność od Pi zamiast obchodzić ją prywatnymi polami.

- [x] Zdefiniować zdarzenia wymagające publikacji: rzeczywista zmiana stanu niewidoczna jeszcze w rozmowie, kompakcja, odtworzenie brakującego kontekstu, zmiana aktywnej gałęzi.
- [x] Oprzeć deduplikację na aktywnej sesji/gałęzi, tożsamości stanu i rzeczywistej obecności informacji w kontekście. Sam procesowy cache „już wysłano” nie wystarczy po restarcie lub kompakcji.
- [x] Nie publikować „brak planu” przy każdym żądaniu. Usunięcie albo zmiana wcześniej widocznego planu musi jednak zostać jednoznacznie odzwierciedlona.
- [x] Odtwarzać working-state checkpointu bez powielania historycznego `planSummary` obok aktualnego planu. Zachować możliwość odczytu starszych formatów.
- [x] Publikować recovery tylko dla istotnego stanu lub błędu; zachować rozróżnienie między zapisanym wynikiem a aktualną żywotnością procesu.
- [x] Importować oczekujące wyniki do planu przed przygotowaniem informacji dla modelu. Skoordynować z punktem 10 wcześniejszego planu napraw.
- [x] Zachować read-only dla danych odziedziczonych/obcych, obsługę błędu zapisu i brak publikacji niepotwierdzonego stanu.

**Odbiór:**
- 6/6 kontrolowanych przejść bez zmiany stanu kwalifikuje się do delta przy dostępnej kontynuacji; nie pojawiają się nowe dopiski, wpisy ani tury.
- Zmiana stanu jest widoczna przed następną zależną decyzją modelu, ale nie modyfikuje wcześniej wysłanego prefiksu. Po kompakcji dopuszczalny jest jawny reset kontynuacji i nowe pełne żądanie.
- Reload, restart, fork, zmiana gałęzi oraz kompakcja z zachowaniem części historii i bez niej nie gubią aktualnego stanu ani nie duplikują komunikatów.

## 4. Naprawa adaptera Kiro — oddzielna implementacja

**Właściciel zmiany:** źródłowy projekt `pi-provider-kiro`, nie globalny plik `dist/index.js` użytkownika.

- [x] Ustalić i zatwierdzić lokalizację projektu providera lub przygotować minimalne zgłoszenie upstream; ten dokument nie upoważnia do modyfikowania globalnej instalacji.
- [x] Normalizować całą rozmowę, łącznie z granicą `history`/`currentMessage`, zanim zostanie wysłana.
- [x] Łączyć sąsiadujące wiadomości użytkownika z zachowaniem kolejności treści, obrazów, wyników narzędzi i właściwego katalogu narzędzi.
- [x] Zachować powiązania tool-use/tool-result. Konflikty identyfikatorów i niemożliwe do naprawienia struktury zgłaszać lokalnie; nie usuwać treści po cichu.
- [x] Walidować końcowe body. Nie wysyłać znanej niepoprawnej struktury ani nie ponawiać jej bez zmiany.
- [x] Dodać regresję dla błędnych/przerwanych odpowiedzi modelu usuwanych podczas normalizacji.

**Odbiór:** wszystkie minimalne i syntetyczne historyczne warianty przechodzą walidację kompletnego requestu; żaden wynik ani obraz nie ginie. Następnie ograniczony test live na niesensytywnych danych. Raportować numer wersji/commit providera. Do czasu dostępności poprawki utrzymywać jawne ograniczenie kompatybilności — naprawa subagents nie oznacza naprawienia Kiro.

## 5. Budżet bajtów i bezpieczna reakcja

**Miejsca:** `context-policy.ts`, `context-guard.ts`, `config.ts`; ewentualny osobny PR do Pi/pi-ai.

- [ ] Ustalić, gdzie można zmierzyć końcowe JSON body i ramkę po serializacji oraz po wyborze delta/full. Osobno raportować pełny rozmiar wymagany przy reconnect/fallback.
- [ ] Jeśli dostępny jest jedynie szacunek rozszerzenia, oznaczać go jako szacunek; nie traktować jako twardej gwarancji niewysłania zbyt dużego body.
- [ ] Zaprojektować walidowane budżety zależne od providera/transportu: ostrzeżenie, bezpieczna kompakcja i ewentualny limit wysłania. Nie hardkodować 1 MiB jako potwierdzonego limitu wszystkich modeli.
- [ ] Uwzględniać UTF-8, obrazy, schematy i podpisane dane rozumowania, a nie tylko długość tekstu lub liczbę tokenów.
- [ ] Wykonywać kompakcję w bezpiecznym punkcie natywnego cyklu Pi, bez abort/deadlock podczas `turn_end`. Uwzględnić budżet żądania używanego do samego podsumowania.
- [ ] Ograniczyć automatyczne próby naprawy: ponowienie tylko po mierzalnej zmianie kontekstu, bez nieskończonego wysyłania identycznego odrzuconego żądania.
- [ ] Gdy sam system prompt, katalog narzędzi albo niepodzielna najnowsza grupa przekracza budżet, zwrócić jasną diagnozę zamiast odcinać fragmenty protokołu.
- [ ] Logować domyślnie tylko rozmiary, rodzaj transportu, powód resetu delta, kod błędu i dostępny identyfikator requestu; bez treści rozmowy, tokenów autoryzacji i surowych body.

**Odbiór:** testy poniżej/na/powyżej skonfigurowanego progu, Unicode, dużej grupy narzędzi, reconnect/full fallback i nieudanej kompakcji. Brak automatycznej kompakcji dla dowolnego `REQUEST_BODY_INVALID`. Jeżeli brak API hosta uniemożliwia twardą ochronę, etap pozostaje częściowo zablokowany i tak jest opisany w wydaniu.

## 6. Instrukcje i stały narzut

- [ ] Usunąć bezwarunkowe „Read plan_read” i „Re-read plan_read” z rutynowo przekazywanych danych. Odczyt zalecać przy brakujących szczegółach, koniecznej weryfikacji uprawnień/rewizji lub konflikcie zapisu.
- [ ] Nie eliminować odczytów wymaganych przez kontrakt narzędzia bez równoczesnej, bezpiecznej zmiany tego kontraktu. Kontrola rewizji i uprawnień pozostaje obowiązkowa.
- [ ] Skrócić powtarzające się instrukcje narzędzi asynchronicznych, zachowując zakaz pollingu, zasady odbioru wyników i bezpiecznego zamykania.
- [ ] Rozważyć krótszy katalog modeli/agentów albo pobieranie szczegółów na żądanie. Zachować dokładne identyfikatory modeli i możliwość sprawdzenia dostępności.
- [ ] Optymalizację/lazy-loading zaawansowanych schematów potraktować jako osobną zmianę opcjonalną; nie usuwać narzędzi wymaganych do poprawnej interpretacji historycznych wywołań.
- [ ] Dodać wskazówki dotyczące ograniczonych odczytów dużych plików i używania natywnej kompakcji. Nie obcinać automatycznie arbitralnych wyników narzędzi.

**Odbiór:** benchmark pokazuje niższy stały narzut i krótsze potwierdzenia; zwykła rozmowa bez planu nie dostaje projekcji pustego planu. Ograniczony eksperyment A/B z tym samym zadaniem mierzy liczbę odczytów, tur i rzeczywiste usage; wynik nie jest uznawany za deterministyczny test ani gwarancję procentowej oszczędności.

## 7. Weryfikacja i wydanie

- [ ] Uruchomić nowe regresje oraz istniejące testy kontekstu, planu, recovery, fork/resume, uprawnień i dostarczania wyników.
- [ ] Uruchomić pełne `npm test`, `npm run lint` i `git diff --check` dla uzgodnionej macierzy wersji.
- [ ] Wykonać integracje zgodnie z `.pi/skills/run-integration-tests/SKILL.md`; dla dodatkowych sesji terminalowych użyć `.pi/skills/verify-pi-herdr-subagents/SKILL.md`. Brak herdr jest blokadą, nie wynikiem pozytywnym.
- [ ] Sprawdzić w rzeczywistym Pi/herdr: dłuższą serię narzędzi, aktualizację planu, wynik dziecka, checkpoint, kompakcję, reload/resume i zmianę modelu Codex → Kiro.
- [ ] Testy live wykonywać na syntetycznych/niesensytywnych danych z uzgodnionym limitem żądań/kosztu; nie odtwarzać automatycznie całej prywatnej sesji.
- [ ] Porównać before/after: liczbę żądań, tokeny wejścia/cache/wyjścia, maksymalne body, kwalifikację do delta, rozmiary potwierdzeń oraz poprawność końcowego zadania.
- [ ] Zaktualizować `README.md`, `CONTRACTS.md`/`ARCHITECTURE.md` tam, gdzie zmienia się kontrakt, konfigurację przykładową, wymagania wersji i zapis ograniczeń.

### Warunki zamknięcia

Implementacja w tym repo może być odebrana tylko z dowodami dla powyższych kryteriów. Zależności od Kiro/Pi mają oddzielny status i wskazaną wersję zawierającą poprawkę. Nie przedstawiać całości jako naprawionej, jeśli normalizacja providera albo ochrona przed wysłaniem nadal czeka na zmianę zewnętrzną.

Nie wymagać od testu live celowego przekroczenia niepotwierdzonego limitu backendu. Jeśli taka próba będzie potrzebna do potwierdzenia przyczyny historycznego błędu, zaplanować ją oddzielnie. Wynik audytu i status wdrożenia pozostają odrębnymi informacjami.

## Proponowany podział commitów/PR

1. Macierz kompatybilności i syntetyczne regresje transportowe.
2. Kompaktowe odpowiedzi narzędzi planowania/checkpointu.
3. Stabilna publikacja kontekstu wraz z testami restart/branch/compaction.
4. Osobny PR w Kiro: normalizacja i walidacja finalnego requestu.
5. Diagnostyka i budżety bajtów; osobny PR hosta, jeżeli wymagany.
6. Skrócenie instrukcji/katalogów i benchmark narzutu.
7. Integracje, dokumentacja i raport odbioru z jawnymi zależnościami.
