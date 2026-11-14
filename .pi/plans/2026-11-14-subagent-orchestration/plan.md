# Plan rozwoju architektury i widoczności podagentów

Data: 2026-11-14
Status: zatwierdzony do realizacji — wdrażanie punktami, osobny commit na punkt
Zakres: pi-herdr-subagents, bieżące drzewo robocze wraz z niezacommitowanymi zmianami

## 1. Cel i główna rekomendacja

Zachować obecną architekturę asynchronicznego uruchamiania podagentów w osobnych terminalach herdr. Najpierw poprawić niezawodność istniejącego mechanizmu, następnie dodać trwały stan zadań i czytelny przepływ informacji.

Największa luka: rozszerzenie modeluje stan agenta, ale nie modeluje jeszcze realizacji zadania i przekazywanych decyzji.

Panel planu z checkboxami powinien być widokiem rzeczywistego, trwałego stanu zadań. Nie może utożsamiać zakończenia procesu ze spełnieniem wymagań.

## 2. Co zachować

- Asynchroniczną delegację i automatyczny powrót wyników, bez odpytywania przez model.
- Rozdzielenie procesu, tury, obserwacji i dostarczenia wyniku.
- Interrupt przerywający turę, a nie kończący sesję.
- Wyspecjalizowane role i ograniczanie dalszej delegacji przez wykonawców.
- Jawny wybór kontekstu: standalone, lineage-only, fork.
- Karty zleceń i odpowiedzi; karta zlecenia nie powinna ponownie wysyłać zadania do modelu.
- Ograniczenie powiadomień uruchamiających rodzica do informacji wymagających reakcji.
- Sekwencyjną pracę workerów we wspólnym repozytorium.

Nie wprowadzać domyślnie pełnej historii dla wszystkich podagentów, komunikacji każdy-z-każdym ani dużego silnika workflow.

## 3. Stan obecny

Przepływ:

```text
Agent główny
  → wybór roli i przygotowanie zadania
  → uruchomienie sesji w herdr
  → obserwacja procesu i aktywności
  ← wynik / błąd / prośba o pomoc
  → decyzja o dalszych działaniach
```

- `/plan` wczytuje instrukcję dla modelu. Nie tworzy trwałego planu ani nie egzekwuje etapów.
- Wynik Pi jest przede wszystkim ostatnią niepustą wypowiedzią asystenta.
- Widget przedstawia uruchomienia agentów; zakończone wpisy znikają.
- `caller_ping` kończy sesję i przekazuje prośbę do rodzica. Nie pozostawia trwałego stanu zablokowanego zadania.
- Zagnieżdżony podagent raportuje do bezpośredniego rodzica, nie automatycznie do sesji głównej.
- Rejestr uruchomień przetrwa `/reload` w tym samym procesie, ale nie restart orchestratora.
- Workflow zakłada zewnętrzne `todo`, `write-todos` i `commit`. Ta paczka ich nie dostarcza; współdzielenie magazynu todo między sesjami nie zostało potwierdzone.

## 4. Etap 1 — wiarygodność wykonania i dostarczania

### R1. Unikalne artefakty wejściowe

- [x] Umieścić niepowtarzalny identyfikator uruchomienia we wszystkich nazwach artefaktów przekazywanych dziecku: zadanie, system prompt, wiadomość resume.
- [x] Dodać regresję dla równoległych uruchomień o tej samej nazwie w tej samej sekundzie.

Problem: nazwy oparte na nazwie agenta i czasie zaokrąglonym do sekundy mogą się pokrywać. Izolowany reproduktor niezależnego przeglądu potwierdził nadpisanie promptu: karta pierwszego agenta może pokazywać TASK_A, podczas gdy oba uruchomienia odczytają TASK_B.

Akceptacja: każde uruchomienie otrzymuje własną, niezmienną treść zadania zgodną z kartą zlecenia.

### R2. Jedna ścieżka aktywności

- [x] Ujednolicić wyznaczanie pliku aktywności między rodzicem a sterownikiem Pi.
- [x] Dodać test kontraktu sprawdzający zgodność ścieżki zapisu dziecka i odczytu rodzica.

Problem: rodzic oczekuje `subagent-activity/<id>.json`, a sterownik Pi przekazuje `subagent-activity-<id>.json`.

Akceptacja: rodzic odczytuje właściwy snapshot i pokazuje szczegóły narzędzia/aktywności, gdy są dostępne.

### R3. Bezpieczne dostarczanie wyników

- [x] Nie usuwać oczekującego wyniku ani nie oznaczać go jako dostarczonego przed skutecznym przekazaniem.
- [x] Zachować wynik podczas wymiany API przy `/reload` i wznowić dostarczanie po gotowości nowej sesji.
- [x] Wprowadzić identyfikację zdarzeń i deduplikację ponowień.
- [x] Określić granicę potwierdzenia dostarczenia dostępną w API Pi; nie obiecywać exactly-once na podstawie flagi w pamięci.
- [x] Dodać test wyjątku `sendMessage` oraz ukończenia dziecka w trakcie `/reload`.

Problem: obecnie wpis zostaje oznaczony jako dostarczony i usunięty przed `sendMessage`. Wyjątek może pozostawić wynik bez kolejnej próby. Ścieżka błędu została potwierdzona analizą kodu; bez live reprodukcji wyścigu.

Akceptacja: wynik nie znika w oknie reloadu, a ponowienie nie tworzy powtórnej realizacji zadania.

Weryfikacja R3: `test/delivery.test.ts` obejmuje wspólną ścieżkę settlement/dispatch spawn i resume (wynik, ping, błąd providera i watchera), ten sam niezmienny envelope po synchronicznym wyjątku, ograniczony backoff bez statusu i aktywnych dzieci, deduplikację, ponowne załadowanie modułu, oba okna shutdown/factory oraz `session_start`, migrację starego globalnego runtime i tłumienie późnych callbacków po quit/new/resume/fork. `delivered` oznacza tylko normalny synchroniczny powrót `sendMessage: void`; brak potwierdzenia asynchronicznego, exactly-once i trwałości po restarcie (szczegóły: README). Wyniki: focused delivery/rendering 29/29, parent lifecycle 3/3, lint OK; `npm test` 291/310, te same 19 wcześniejszych błędów (18 Python/Claude, 1 regex CRLF release). Bez live herdr E2E — CLI/środowisko niedostępne.

### R4. Bezpieczne resume i kontynuacja żywej sesji

- [x] Odrzucać resume sesji, która ma już aktywnego właściciela.
- [x] Rozróżnić kontynuowanie żywego dziecka po interrupt od uruchomienia zamkniętej sesji.
- [x] Powiązać completion z konkretnym uruchomieniem, nie wyłącznie ze ścieżką JSONL.
- [x] Współdzielić profil uruchomienia między spawn i resume: rola, katalog, ograniczenia narzędzi i pozostała konfiguracja.
- [x] Dodać regresje interrupt → resume oraz równoczesnego resume tej samej sesji.

Akceptacja: nie powstają dwa procesy zapisujące ten sam plik sesji i konkurujące o wspólny completion sidecar.

Weryfikacja R4.2: `live-continuation.ts` rozdziela kontynuację śledzonego żywego dziecka od istniejącej ścieżki saved-profile dla sesji bez właściciela. Rezerwacja przed await, kontrola lifecycle/pane i potwierdzenie dziecka `agent_settled(aborted)` + idle; ten sam proces/run/pane/activity/abort/watcher, bez nowego watchera i bez fallback launch po awarii transportu. Prywatna komenda przenosi wyłącznie UUID, atomowy request jest run-bound; dziecko waliduje token idle i payload oraz wywołuje `sendUserMessage` z `expandPromptTemplates:false`. Trwałe artefakty accepted/rejected/dispatching deduplikują; stan niepewny blokuje retry. Testy focused continuation/ownership/profile/delivery: 40/40, lint bez ostrzeżeń; pełne `npm test`: 335/355 (18 Python/Claude, 1 CRLF release, 1 istniejący nieaktualny test oczekujący `Defaults to true` zamiast zachowania zapisanego autoExit). Dowody na mockach API Pi i transportu; brak live herdr, brak dowodu terminal E2E. Semantyka R5 pozostaje otwarta.

Weryfikacja R4.5: `test/ownership-execute.test.ts` dodaje regresje na zarejestrowanych narzędziach execute: interrupt bez settlement nie wystarcza; po `agent_settled(aborted)` dokładna wielowierszowa wiadomość z prefiksami specjalnymi trafia przez API dziecka bez ekspansji, przy zachowaniu run/pane/activity/abort i działającego pierwotnego watchera. Bramki inspekcji dowodzą pojedynczego zwycięzcy równoczesnych resume dla żywej i zamkniętej sesji, przed dispatch/launch. Osobna regresja zachowuje odzyskiwanie brakującego pane przed wyborem śledzonego live run. Unikalne fixture `mkdtemp`; mocki wyłącznie granic OS i API Pi, bez live herdr. Focused ownership/continuation/resume/profile/delivery: 49/49; lint OK; pełne `npm test`: 345/364, te same 19 błędów bazowych (18 Claude/Python, 1 CRLF release). Bez zmian R5 ani dowodu terminal E2E.

### R5. Jasna semantyka keepOpen

- [x] Wybrać i udokumentować jeden model: dalsza śledzona współpraca albo jednorazowe przekazanie terminala użytkownikowi.

Decyzja użytkownika: dalsza śledzona współpraca. `keepOpen` zachowuje nadzór i właściciela sesji; zakończenie tury publikuje wynik, ale nie kończy obserwacji. Kolejne wyniki wracają do bezpośredniego rodzica. Zakończenie nadzoru wymaga potwierdzonego zamknięcia procesu albo jawnego przekazania terminala. Sam wybór modelu nie oznacza ukończenia implementacji poniżej.
- [ ] Dostosować rejestr, watcher, publikację kolejnych wyników i komunikaty do wybranego modelu.
- [ ] Przetestować follow-up po pierwszym zakończeniu.

Problem: terminal zostaje otwarty, ale obserwacja kończy się i wpis znika. Kolejne automatyczne wyniki nie mają obecnie pełnego kanału dostarczenia.

### R6. Jawne możliwości harnessów

- [x] Dodać deklarację obsługi fork i innych operacji wymagających konkretnego harnessu.
- [x] Odrzucać nieobsługiwane kombinacje przed utworzeniem terminala.
- [x] Dodać testy zgodności obietnicy dziedziczenia kontekstu z faktyczną komendą uruchomienia.

Problem: opcja fork nie zapewnia jednakowej semantyki w sterownikach Pi, Claude i Codex.

### Dodatkowe utwardzenie

- [x] Usunąć synchroniczne health-checki terminala z gorącej ścieżki asynchronicznego monitorowania; ograniczyć współbieżność zapytań.

Weryfikacja: `readPaneAsync`/`inspectPane` wykonują świeże asynchroniczne zapytania bez synchronicznego preflightu; discovery CLI również jest asynchroniczne. Wspólny limit 4 procesów obejmuje legacy herdr, hc, odczyty, inspekcje i discovery; timeout CLI wynosi 15 s. Inspekcja błędu transportu/discovery/parsowania zwraca `unavailable`, bez poprzedniego stanu `present`; synchroniczne kontrole przed uruchomieniem pozostają. `test/terminal-queries.test.ts` dodano do `npm test`: regresje transportów, awarii, retry discovery, braku sync subprocessów, współdzielonego limitu i zwalniania slotów. Focused terminal/hc 20/20, lint OK; pełne `npm test` 308/327, te same 19 błędów bazowych (18 Python/Claude hook, 1 regex CRLF release). Dowody na mockach granic OS; brak live herdr E2E.
- [ ] Określić zachowanie przy restarcie rodzica i utrwalić manifest uruchomień oraz oczekujące wyniki, jeżeli nadzór ma być odtwarzany.
- [ ] Przy odtwarzaniu powiązać uruchomienia z właściwą sesją/gałęzią i sprawdzić rzeczywistą obecność procesów; nie uruchamiać ponownie pracy wyłącznie na podstawie starego stanu.

## 5. Etap 2 — trwały plan i panel zadań

### Model

- [ ] Wprowadzić stabilne identyfikatory `planId`, `taskId`, `runId`.
- [ ] Oddzielić zadanie od prób jego realizacji; resume i retry nie tworzą nowego zadania.
- [ ] Przechowywać tytuł, zakres, kryteria akceptacji, zależności, właściciela, powiązane uruchomienia, artefakty i dowody.
- [ ] Rozróżniać stany: oczekuje, realizowane, zablokowane, do weryfikacji, zaakceptowane, nieudane oraz pominięte/anulowane.
- [ ] Zachować stan zadań po zamknięciu terminala, reloadzie i wznowieniu sesji.
- [ ] Jawnie określić semantykę rozgałęziania sesji i zmian planu.

Nie utożsamiać sukcesu procesu z sukcesem zadania. Zgłoszenie wykonania przez workera prowadzi do weryfikacji. Checkbox oznacza spełnienie wymaganych kryteriów, a nie samą deklarację. Zakres weryfikacji zależy od zadania — nie każda drobna zmiana wymaga osobnego review lub ręcznej zgody użytkownika.

### Panel głównej sesji

- [ ] Wyświetlać listę punktów, statusy, role/właścicieli, blokady i licznik zaakceptowanych zadań.
- [ ] Pozostawiać zakończone zadania w planie, mimo usunięcia agentów z widgetu procesów.
- [ ] Zachować blokadę i jej przyczynę po `caller_ping`.
- [ ] Dla długich planów udostępnić skrót oraz rozwijaną pełną listę.
- [ ] Udostępnić szczegóły zadania: kryteria, próby, wyniki, testy, decyzje i odnośniki do sesji.

Przykład:

```text
Plan: Przebudowa logowania                2/6 zaakceptowanych

✓ T1  Analiza obecnego rozwiązania    scout       zakończone
✓ T2  Projekt zmian                   planner     zatwierdzone
◐ T3  Implementacja API               worker      weryfikacja
! T4  Migracja danych                 —           potrzebna decyzja
○ T5  Integracja UI                   —           czeka na T3
○ T6  Testy i przegląd całości         reviewer    oczekuje
```

### Jedno źródło prawdy

- [x] Ustalić, czy rozszerzenie ma własny minimalny magazyn zadań, czy adapter do istniejącego zewnętrznego `todo`.

Decyzja użytkownika: własny minimalny magazyn planów i zadań w rozszerzeniu, bez zależności od zewnętrznego `todo`. Panel i narzędzia modelu korzystają z tego samego stanu; ewentualny przyszły adapter nie tworzy niezależnej listy.
- [ ] Nie utrzymywać dwóch niezależnych list wymagających ręcznej synchronizacji.
- [ ] Sprawdzać dostępność wymaganych narzędzi i umiejętności przed obietnicą pełnego workflow.
- [ ] Zapewnić dostęp modelu do aktualnego skrótu planu także po kompakcji; sam widget i wpisy display-only nie stanowią kontekstu modelu.

Akceptacja etapu: użytkownik i agent główny potrafią jednoznacznie wskazać, co jest zaakceptowane, co jest wykonywane, co jest zablokowane i dlaczego.

## 6. Etap 3 — przepływ informacji i jakość wyników

### Pochodzenie i historia przekazań

- [ ] Powiązać plan → zadanie → zlecenie → próba → wynik → dowód → weryfikacja.
- [ ] Zachować identyfikator bezpośredniego rodzica i sesji głównej.
- [ ] Dodać krótką historię jawnych komunikatów, decyzji i zmian stanu.
- [ ] Dodać zwijane drzewo zagnieżdżonych podagentów bez kopiowania ich całych rozmów do rodzica głównego.

Przykład:

```text
12:10  Główny → Worker      T3: implementacja API
12:13  Worker → Główny      Blokada: dwa warianty schematu
12:14  Główny → Worker      Decyzja: użyj wariantu B
12:18  Worker → Główny      Implementacja gotowa; testy 24/24
12:19  Główny → Reviewer    Sprawdź kryteria T3
```

Historia nie obejmuje wewnętrznego toku rozumowania modeli.

### Kontrakt zlecenia i wyniku

- [ ] Zlecenie: cel, zakres, kryteria akceptacji, zależności, potrzebne pliki/decyzje, ograniczenia zmian.
- [ ] Wynik: wykonane/częściowe/zablokowane, podsumowanie, artefakty, sprawdzenia i rezultaty, niespełnione kryteria, ryzyka.
- [ ] Powiązać dowody z kryteriami; samo pole `testsPassed` lub tekst „gotowe” nie wystarcza.
- [ ] Zachować kompatybilność z wynikami tekstowymi; brak struktury nie może automatycznie oznaczać akceptacji.

### Polityka komunikatów

- [ ] UI aktualizować bez dodatkowych tur modelu.
- [ ] Model budzić dla wyników, blokad, pytań i decyzji wymagających reakcji.
- [ ] Zwykły postęp udostępniać w panelu lub zbiorczym skrócie zamiast strumienia powiadomień.
- [ ] Rozważyć niewymuszający zakończenia sesji kanał pytania/postępu dopiero po ustaleniu bezpiecznej kontynuacji żywego dziecka.

### Dopasowanie instrukcji ról

- [ ] Zweryfikować zgodność wymaganych czynności z dostępnymi narzędziami; scout i reviewer proszą o zapis raportów, choć deklarują tylko `read, bash`.
- [ ] Preferować sensowne, weryfikowalne jednostki pracy zamiast sztywnego wymogu zadań na 2–5 minut.
- [ ] Uzależnić commitowanie od polityki projektu i polecenia użytkownika, nie od bezwarunkowego zamknięcia każdego todo.
- [ ] Przekazywać ścieżki do artefaktów i celowane skróty zamiast wielokrotnego wklejania całych raportów.
- [ ] Równoległych workerów modyfikujących kod wprowadzać dopiero z izolacją, np. worktree, i etapem integracji.

## 7. Docelowe granice architektury

```text
Plan i zadania
      ↓
Zlecenia i próby wykonania
      ↓
Obecny runtime podagentów
      ↓
Wyniki i zdarzenia
      ├─ aktualizacja planu
      ├─ panel / historia
      └─ istotne komunikaty do modelu
```

Trzy odrębne modele:

1. Runtime: proces, tura, interrupt, zakończenie.
2. Zadanie: oczekuje, realizowane, zablokowane, do weryfikacji, zaakceptowane.
3. Dostarczenie: wynik oczekuje, został przekazany, wymaga ponowienia.

- [ ] Wydzielać discovery, uruchamianie, dostarczanie i UI z `index.ts` przy okazji realizacji zmian, bez jednorazowego przepisywania całości.
- [ ] Współdzielić ścieżki spawn i resume oraz definicję manifestu uruchomienia.
- [ ] Określić jedno miejsce zatwierdzania zmian zadania; dzieci zgłaszają wyniki zamiast niezależnie nadpisywać wspólny stan.
- [ ] Użyć natywnych mechanizmów Pi do widgetów i zapisów sesji tam, gdzie wystarczą; trwały transport wyników traktować oddzielnie od prezentacji.

## 8. Kolejność i mierzalne efekty

| Etap | Najważniejszy efekt |
| --- | --- |
| 1. Wiarygodność | Brak pomylonych promptów, zgubionych wyników i podwójnych właścicieli sesji |
| 2. Plan i checkboxy | Czytelny, trwały stan realizacji oraz blokad |
| 3. Przepływ i jakość | Możliwość prześledzenia decyzji, dowodów i przyczyn poprawek |

Mierzyć przed i po wdrożeniu:

- liczbę zgubionych lub zduplikowanych wyników;
- odsetek zadań zaakceptowanych bez poprawki;
- czas spędzony w blokadzie;
- liczbę powrotów po brakujący kontekst;
- czas oraz koszt na zaakceptowane zadanie.

Nie traktować liczby uruchomionych agentów, liczby komunikatów ani samego zakończenia procesów jako miary jakości.

## 9. Testy i granice weryfikacji

W czasie analizy:

- `npm run lint`: OK.
- `npm test`: 271/290 zaliczonych.
- 18 błędów dotyczyło niedostępnego Pythona w testach hooka Claude.
- 1 błąd dotyczył regexu nieuwzględniającego CRLF w teście workflow wydawniczego.
- Niezależny przegląd potwierdził kolizję promptów izolowanym reproduktorem bez uruchamiania procesów.
- Nie wykonano pełnego live E2E ani live reprodukcji wyścigu przy reloadzie.

Przed uznaniem wdrożenia za zakończone:

- [ ] Testy jednostkowe przejść stanów, deduplikacji, unikalności artefaktów i kontraktów ścieżek.
- [ ] Testy odtwarzania planu, powtórnych prób, zależności, blokad oraz rozgałęzień sesji.
- [ ] Testy renderowania dla długich planów, wąskich terminali i historii wyników.
- [ ] Testy live: równoległy spawn, wynik podczas reloadu, interrupt/kontynuacja/resume, wybrana semantyka keepOpen.
- [ ] Testy restartu i odtworzenia nadzoru, jeśli taka gwarancja zostanie wdrożona.
- [ ] Testy możliwości wspieranych harnessów; jawne odrzucanie nieobsługiwanych operacji.

## 10. Źródła i punkty odniesienia

Plan powstał na podstawie analizy w rozmowie oraz dwóch niezależnych przeglądów: workflow planowania/przepływu informacji i lifecycle/niezawodności. Dotyczy bieżącego drzewa roboczego, nie wyłącznie ostatniego commita. Numery linii mogą zmienić się przy implementacji.

Najważniejsze pliki:

- `pi-extension/subagents/index.ts`: rejestr uruchomień, spawn, watch, dostarczanie, resume, widget i `/plan`.
- `pi-extension/subagents/lifecycle.ts`: rozdzielenie procesu, tury i dostarczania.
- `pi-extension/subagents/completion.ts`: completion sidecars, sentinele i obserwacja terminala.
- `pi-extension/subagents/activity.ts`: format i ścieżki snapshotów aktywności.
- `pi-extension/subagents/subagent-done.ts`: auto-exit, caller_ping, keepOpen.
- `pi-extension/subagents/harness/drivers/pi.ts`: artefakty promptów, konfiguracja dziecka i metadata zlecenia.
- `pi-extension/subagents/harness/drivers/claude.ts`, `codex.ts`: granice obsługi fork.
- `pi-extension/subagents/assignment.ts`: trwała karta zlecenia display-only.
- `pi-extension/subagents/session.ts`: kontekst sesji i wydobycie odpowiedzi.
- `pi-extension/subagents/plan-skill.md`, `agents/*.md`: instrukcje workflow i ról.
- `test/assignment.test.ts`, `test/response-rendering.test.ts`, `test/test.ts`: istniejące punkty zaczepienia testów.

Zapisanie tego dokumentu nie oznacza zatwierdzenia wszystkich decyzji ani rozpoczęcia implementacji.
