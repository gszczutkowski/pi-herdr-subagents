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
- [x] Dostosować rejestr, watcher, publikację kolejnych wyników i komunikaty do wybranego modelu.

Weryfikacja implementacji R5: per-turn run-bound artefakty z niezmiennym snapshotem wyniku, oddzielny lifecycle każdej dostawy w outbox, zachowany watcher i właściciel keepOpen, guarded settled-idle follow-up oraz jawna granica Pi-only. Focused delivery/continuation/resume/profile/rendering: 51/51; lint OK. Bez live herdr E2E; regresje follow-up poniżej pozostają osobnym krokiem.
- [x] Przetestować follow-up po pierwszym zakończeniu.

Weryfikacja regresji R5: `test/keep-open.test.ts` sprawdza wielokrotną publikację dziecka (autoExit true/false), trwały wybór close:false mimo domyślnego closeOnDone:true, snapshoty i identyfikatory tur, brak podwójnej publikacji tool/settled, abort bez wyniku oraz jawne close:true. `test/ownership-execute.test.ts` przechodzi przez rzeczywiste execute resume/watcher i bridge: follow-up po pierwszym wyniku, dokładna wiadomość i dedup komendy, ręczna kolejna tura, idle/open widget, ten sam run/pane/watcher/owner, dwie niezależne dostawy zachowane przez błąd i reload, brak duplikatu oraz zamknięcie nadzoru po zniknięciu pane. Focused 63/63, lint OK; pełne npm test 348/367, te same 19 błędów bazowych (18 Claude/Python, 1 CRLF release). Dowody na mockach OS/API Pi; brak live herdr E2E i brak gwarancji odtworzenia po restarcie.

Problem: terminal zostaje otwarty, ale obserwacja kończy się i wpis znika. Kolejne automatyczne wyniki nie mają obecnie pełnego kanału dostarczenia.

### R6. Jawne możliwości harnessów

- [x] Dodać deklarację obsługi fork i innych operacji wymagających konkretnego harnessu.
- [x] Odrzucać nieobsługiwane kombinacje przed utworzeniem terminala.
- [x] Dodać testy zgodności obietnicy dziedziczenia kontekstu z faktyczną komendą uruchomienia.

Problem: opcja fork nie zapewnia jednakowej semantyki w sterownikach Pi, Claude i Codex.

### Dodatkowe utwardzenie

- [x] Usunąć synchroniczne health-checki terminala z gorącej ścieżki asynchronicznego monitorowania; ograniczyć współbieżność zapytań.

Weryfikacja: `readPaneAsync`/`inspectPane` wykonują świeże asynchroniczne zapytania bez synchronicznego preflightu; discovery CLI również jest asynchroniczne. Wspólny limit 4 procesów obejmuje legacy herdr, hc, odczyty, inspekcje i discovery; timeout CLI wynosi 15 s. Inspekcja błędu transportu/discovery/parsowania zwraca `unavailable`, bez poprzedniego stanu `present`; synchroniczne kontrole przed uruchomieniem pozostają. `test/terminal-queries.test.ts` dodano do `npm test`: regresje transportów, awarii, retry discovery, braku sync subprocessów, współdzielonego limitu i zwalniania slotów. Focused terminal/hc 20/20, lint OK; pełne `npm test` 308/327, te same 19 błędów bazowych (18 Python/Claude hook, 1 regex CRLF release). Dowody na mockach granic OS; brak live herdr E2E.
- [x] Określić zachowanie przy restarcie rodzica i utrwalić manifest uruchomień oraz oczekujące wyniki, jeżeli nadzór ma być odtwarzany.

Decyzja użytkownika — restart B: nigdy automatycznie nie uruchamiać ponownie zadania. `runtime-store.ts` utrwala wersjonowany manifest i dokładne envelope outbox w artefaktach rodzica; checkpoint/token gałęzi, canonical session/headerId, rewizja/generacja, fazy prepared/dispatch-intent/supervised, profil, lokalizatory i baseline resume. Obie rzeczywiste ścieżki execute zapisują zamiar przed transportem. Envelope i cursor są atomowe, niezmienne zdarzenia dziecka pozostają na dysku. Lease nie jest przejmowany na podstawie wieku; korupcja/nieznana wersja blokuje zapis. Outbox zapisuje dispatching przed void sendMessage oraz tombstone handedOff przed callbackiem; crash dispatching oznacza UNKNOWN, bez ślepego replay. Normalny powrót API nie potwierdza trwałości w Pi ani exactly-once. Ten commit nie adoptuje procesów. Weryfikacja: focused runtime-store/runtime-execute/delivery/ownership/keep-open 36/36; lint exit 0. Testy realnego execute spawn/resume z mockami wyłącznie granic OS/Pi, dwa wyniki keepOpen i reopen w świeżym procesie Node; bez live herdr.
- [x] Przy odtwarzaniu powiązać uruchomienia z właściwą sesją/gałęzią i sprawdzić rzeczywistą obecność procesów; nie uruchamiać ponownie pracy wyłącznie na podstawie starego stanu.

Weryfikacja restartu B: `runtime-recovery.ts` nie wywołuje builderów, skryptów ani terminala. Startup waliduje canonical parent/headerId i checkpoint/token wyłącznie aktywnego `getBranch()`, uzyskuje fenced lease oraz synchronicznie rezerwuje sesje przed await. PID+OS birth (Linux boot/start ticks, Windows creation time) pozwala przejąć tylko potwierdzony martwy writer; lease legacy/nieznany i równoczesny żywy rodzic blokują przejęcie, bez heurystyki wieku. Dziecko Pi publikuje niezmienną tożsamość procesu i odpowiada z timera nie-modelowego na świeży challenge powiązany z generacją, nonce procesu, runId, canonical session i headerId. Po await ponownie sprawdzany jest aktualny właściciel. Działa wyłącznie artifact-only supervision; keepOpen nadal publikuje kolejne wyniki. Obecność pane NIE potwierdza pane→process: odzyskane sterowanie/interrupt/continuation/close są wyłączone; teardown po utracie custody nie zamyka pane. Rezerwacje i niepewne continuation request IDs pozostają, bez replay. `/tree` trwale pauzuje custody do jawnej decyzji; fork/new/kopia nie dziedziczą runów. Outbox odtwarzany niezależnie od życia dziecka: matching envelope na aktywnej gałęzi tłumi replay, dispatching bez dowodu pozostaje UNKNOWN. `/subagents-recovery` pokazuje decyzje; brak force-resolve/force-resend/relaunch.

Dowody: focused sequential 62/62, zero skip; lint exit 0; pełna enumeracja npm uruchomiona sekwencyjnie: 369/388, zero skip, te same 19 błędów bazowych (18 Claude/Python, 1 CRLF release). Zwykłe równoległe npm test wcześniej: 366/387, 19 bazowych błędów i 2 testy pominięte przy niedostępnym pod obciążeniem probe OS; sekwencyjny run dowodzi obu ścieżek bez skip. Nowe testy obejmują osobne świeże procesy rodzica po śmierci poprzednika, prawdziwy osobny proces respondera, świeże/stare challenge, reuse PID/pane, session/branch mismatch, drugiego rodzica, stary cursor/revision, tombstones, write errors przed i po send oraz dwa późniejsze keepOpen events. Testy execute i Pi host boundary są mockowane, ale OS PID/birth oraz responder/reopen uruchamiają rzeczywiste procesy Node na Windows. Bez live herdr/model E2E. Nie ma obietnicy terminal-adoption, exactly-once ani automatycznego rozwiązania stanów unverified/decision; to celowe fail-closed, nie weryfikacja obecności na podstawie starego pliku/pane/timestamp.

## 5. Etap 2 — trwały plan i panel zadań

### Model

- [x] Wprowadzić stabilne identyfikatory `planId`, `taskId`, `runId`.

Weryfikacja: `plan-store.ts` tworzy UUID planu/zadania, referencjonuje istniejący runtime runId, wersjonuje i zamraża snapshot. `test/plan-store.test.ts`: tożsamość niezależna od tytułów, roundtrip, autorytet i rewizje. Bez integracji runtime/persistence/UI.
- [x] Oddzielić zadanie od prób jego realizacji; resume i retry nie tworzą nowego zadania.

Weryfikacja: osobne attemptId, jawne attachRun dla resume, retry zachowuje taskId; wiele wyników keepOpen pozostaje w tej samej próbie. Testy obejmują deduplikację i konflikt eventId, referencje sesji i roundtrip.
- [x] Przechowywać tytuł, zakres, kryteria akceptacji, zależności, właściciela, powiązane uruchomienia, artefakty i dowody.

Weryfikacja: stabilne criterionId, graf zależności (brakujące/self/cykle odrzucane), ograniczone referencje artefaktów/wyników/dowodów. Akceptacja mapuje wszystkie kryteria do dowodów; edycja definicji unieważnia akceptację do review z zachowaniem historii decyzji. Pokrycie: `test/plan-store.test.ts`.
- [x] Rozróżniać stany: oczekuje, realizowane, zablokowane, do weryfikacji, zaakceptowane, nieudane oraz pominięte/anulowane.

Weryfikacja czterech punktów Model: czysty `pi-extension/subagents/plan-store.ts`, komendy rodzica z sessionId/branchInstanceId/expectedRevision; bez replace-snapshot, runtime hooks, UI i persistence. Jawne przejścia ośmiu statusów i historia przyczyn; wynik workera → in_review, ping → blocked, process_exit nie akceptuje. Późne zdarzenia zachowane bez otwierania terminalnych zadań; duplikaty idempotentne. Akceptacja wyłącznie przez rodzica z dowodami każdego kryterium; reopen/retry jawne. To walidacja logicznego autorytetu, nie sandbox OS ani storage CAS. `node --test --test-reporter=tap test/plan-store.test.ts`: 6/6; `npm run lint`: exit 0; pełne `npm test`: 351/370, te same 19 błędów bazowych (18 Claude/Python, 1 CRLF release). Bez live herdr i bez implementacji kolejnych dwóch punktów Model.
- [x] Zachować stan zadań po zamknięciu terminala, reloadzie i wznowieniu sesji.

Weryfikacja Model 5: natywne pełne snapshoty `pi-subagents-plan/v1`, odczyt wyłącznie aktywnego `getBranch()`, przywracanie session_start/session_tree, zachowanie po kompakcji. `plan_read`/`plan_update` wykonują ograniczone komendy istniejącego modelu z expectedRevision i autorytetem rodzica; bez replace. Błąd append blokuje zapis do jawnego reconcile po ponownym otwarciu dysku; przyszły schemat fail-closed. Sesje ephemeral/setup-only odrzucane. Odtworzone in_progress pozostaje recovery-uncertain, bez launch/accept. Testy natywnego SessionManager w tempfiles oraz rzeczywisty lifecycle Pi z kontrolowanym providerem i modelowym wywołaniem narzędzia: focused 13/13, lint OK. Bez live herdr i bez adapterów runtime/UI/kontekstu.
- [x] Jawnie określić semantykę rozgałęziania sesji i zmian planu.

Weryfikacja Model 6: `/new` bez planu; reload/resume i `/tree` wybierają snapshot aktywnej ścieżki. Natywne fork/clone kopiują faktyczny punkt, obcy autorytet jest read-only. Jawne detach dla kopii i historycznego rollbacku tworzy nowy planId/branchInstanceId z provenance źródła; aktywne odziedziczone próby są blocked i read-only do nowego retry. Wyniki wymagają oryginalnego autorytetu; powrót do istniejącej gałęzi zachowuje tożsamość bez kolejnego klonowania. Edycje zaakceptowanej definicji nadal unieważniają akceptację. `test/plan-branches.test.ts`: natywny SessionManager, tempfiles, tree/rollback/reopen, fork/clone w wybranym punkcie, niezmienione bajty źródła, child/stale/origin guards; zarejestrowane narzędzie obsługuje detach i konflikt równoczesnych komend. Focused 18/18, lint OK; pełne npm test 371/390, te same kategorie 19 błędów bazowych (18 Claude/Python hook, 1 CRLF release). Rzeczywiste lifecycle Pi i modelowe tool-call z kontrolowanym providerem, bez live herdr/provider E2E. Bez implementacji dalszych checkboxów, adapterów runtime, UI lub context injection.

Nie utożsamiać sukcesu procesu z sukcesem zadania. Zgłoszenie wykonania przez workera prowadzi do weryfikacji. Checkbox oznacza spełnienie wymaganych kryteriów, a nie samą deklarację. Zakres weryfikacji zależy od zadania — nie każda drobna zmiana wymaga osobnego review lub ręcznej zgody użytkownika.

### Panel głównej sesji

- [x] Wyświetlać listę punktów, statusy, role/właścicieli, blokady i licznik zaakceptowanych zadań.

Weryfikacja Panel 1: `plan-view.ts` jest czystą projekcją magazynu; natywny widget rejestrowany przez `registerPlanTools`, bez zmiany `/plan` ani tur modelu. Role/właściciele to jawne pole owner (bez zgadywania roli runtime); checkbox tylko dla accepted. Subskrypcja save/restore i odświeżanie narzędzi także po błędzie. `test/plan-view.test.ts`: 3/3, rzeczywisty SessionManager i zarejestrowane execute, osiem statusów, Unicode/wąskie terminale/theme, tree/reload/detach/uszkodzony schemat/pusta gałąź. Bez live herdr i bez adaptera caller_ping.
- [x] Pozostawiać zakończone zadania w planie, mimo usunięcia agentów z widgetu procesów.

Weryfikacja Panel 2: osobny klucz widgetu `subagent-plan`, wiersze wyłącznie z trwałego store (bez runtime map). Regresja wywołuje rzeczywistą ścieżkę `observeSubagentCompletion(supervisionEnded)`: usunięcie ostatniego agenta i wyczyszczenie widgetu procesów nie usuwa zadań in_review/accepted/failed/skipped/cancelled. Odczyt po ponownym otwarciu sesji z dysku zachowuje identyczny plan i licznik 1/5; exit nie akceptuje zadania. Focused panel 4/4; bez live herdr.
- [x] Zachować blokadę i jej przyczynę po `caller_ping`.

Weryfikacja Panel 3: regresja `test/plan-runtime.test.ts` uruchamia rzeczywiste zarejestrowane child `caller_ping`, zapis run-bound artefaktu i pierwotny watcher rodzica. Wspólny adapter zapisuje blocked z dokładną przyczyną w natywnym planie; po usunięciu dziecka z rejestru test renderuje rzeczywisty widget `subagent-plan` i sprawdza tę przyczynę. Reopen SessionManager z dysku i ponowna rejestracja parent extension z nową persistence zachowują blokadę bez relaunch. Duplicate tego samego kanonicznego ping eventId nie dopisuje rewizji, późny ping nie otwiera accepted; przejście do review jest jawną decyzją rodzica. Focused 81/81, lint exit 0; pełne npm test 398/417, te same 19 błędów bazowych (18 Python/Claude hook, 1 CRLF release). Granice terminala/API Pi mockowane; bez live herdr i bez nowych kontraktów strukturalnych.
- [x] Dla długich planów udostępnić skrót oraz rozwijaną pełną listę.

Weryfikacja Panel 4: domyślnie sześć zadań i liczba ukrytych, licznik accepted zawsze dla całego planu. `/plan-view expand|full|compact` oraz przełączanie bez argumentu zmieniają tylko prezentację; istniejący `/plan` pozostaje bez zmian. Test z 30 zadaniami, rzeczywiste komendy, brak nowych wpisów sesji/rewizji, resize 1–120 kolumn. Panel 5/5, lint OK; bez live herdr.
- [x] Udostępnić szczegóły zadania: kryteria, próby, wyniki, testy, decyzje i odnośniki do sesji.

Weryfikacja Panel 5: `/plan-view details Tn|taskId` pokazuje definicję, kryteria, wszystkie próby/run/result refs, checks/evidence z powiązaniami, decyzje accept/invalidate i historię statusów, artefakty i sesje potomne. Dane referencyjne nie są dowodem liveness ani niezależnie wykonanych testów; brak nowych pól autorytetu. Szczegóły zawijane, preview ograniczone do 120 linii z jawnym fallbackiem `plan_read(taskId)` (istniejący limit tekstu 40KB); fallback sprawdzony także bez jakiegokolwiek UI. Wybrany taskId nie przeskakuje na inne zadanie po zmianie gałęzi. Focused panel/store/persistence/branches/history 27/27, natywny lifecycle Pi z kontrolowanym providerem włącznie; lint OK. Pełne `npm test`: 380/399, tylko te same 19 błędów bazowych (18 Python/Claude hook, 1 CRLF release). Bez live herdr. Pominięto caller_ping/runtime task binding/context projection/workflow guidance zgodnie z zakresem.

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
- [x] Nie utrzymywać dwóch niezależnych list wymagających ręcznej synchronizacji.

Weryfikacja: instrukcje planner/worker/plan używają wyłącznie rodzicielskiego `plan_read`/`plan_update`; dzieci zwracają propozycje i dowody, rodzic importuje i weryfikuje akceptację. `plan.md` pozostaje artefaktem projektu, nie drugą listą statusów. Przykłady komend odpowiadają schematowi `plan-tools.ts`; jawne attach `run` bez nieistniejącego adaptera.
- [x] Sprawdzać dostępność wymaganych narzędzi i umiejętności przed obietnicą pełnego workflow.

Weryfikacja: `/plan` wykonuje command-time preflight aktywnych narzędzi, odkrytych ról, wymaganych przez role umiejętności i ich plików, terminala oraz rzeczywistego pliku instrukcji. Błędy wskazują naprawę; opcjonalne helpery mają opisany manualny fallback. Zarejestrowana komenda: `test/plan-preflight.test.ts`; focused preflight/role-guidance 6/6, lint exit 0. Bez live herdr.
- [x] Zapewnić dostęp modelu do aktualnego skrótu planu także po kompakcji; sam widget i wpisy display-only nie stanowią kontekstu modelu.

Weryfikacja: `plan-context.ts` projektuje jeden skrót ≤8192 bajtów UTF-8 (maks. 24 zadania, blokady najpierw) w hooku `context` przed każdym wywołaniem, czytając aktywną gałąź z tej samej instancji persistence co narzędzia. Id/revision, licznik accepted, stany i blokady, prawa dostępu, recovery uncertainty i odsyłacze `plan_read`; usuwa wyłącznie własną wcześniejszą projekcję, bez append/send/nowych tur. Testy: natywna retain-none compaction → mutation → świeży skrót, historyczna/nowa gałąź, child read-only, Unicode, bounds, brak duplikatów i niezmieniona reszta kontekstu. Rzeczywisty lifecycle Pi z kontrolowanym providerem dowodzi aktualizacji między wywołaniami narzędzi w tej samej turze i braku utrwalania skrótu. Focused plan/preflight/guidance 27/27; lint exit 0; pełne npm test 375/394, te same 19 błędów bazowych (18 Claude/Python, 1 CRLF release). Bez live herdr.

Akceptacja etapu: użytkownik i agent główny potrafią jednoznacznie wskazać, co jest zaakceptowane, co jest wykonywane, co jest zablokowane i dlaczego.

## 6. Etap 3 — przepływ informacji i jakość wyników

### Pochodzenie i historia przekazań

- [x] Powiązać plan → zadanie → zlecenie → próba → wynik → dowód → weryfikacja.

Weryfikacja Provenance: opcjonalne `planTask` na zarejestrowanych spawn/resume wiąże istniejącą próbę z runtime runId przez tę samą instancję PlanPersistence co narzędzia/panel/kontekst; append i ponowna walidacja przed transportem. Live zachowuje run/próbę, closed resume dodaje run; retry jest jawną komendą rodzica. Profil, manifest i display-only assignment zachowują oryginalny autorytet i korelację. `plan-runtime.ts` importuje kanoniczny eventId outbox idempotentnie; wynik → review, nigdy accept. Dowód resultEventId i decyzja rodzica zamykają istniejący łańcuch kryteriów. Błąd importu nie zatrzymuje dostawy; także handedOff envelope jest źródłem retry, obca gałąź pozostaje pending. Błąd dispatch po attach zapisuje failed/uncertain. Testy natywnego SessionManager + zarejestrowane execute: spawn, alias/live/closed resume, append/transport failure, duplicate/late/accepted i wrong-branch, świeża persistence oraz reopen manifest binding. Focused 81/81, lint exit 0; pełne npm test 398/417, te same 19 błędów bazowych (18 Python/Claude hook, 1 CRLF release); rzeczywisty lifecycle Pi z kontrolowanym providerem w zestawie persistence/branches/context. Granice OS/Pi transportu mockowane, bez live herdr i bez automatycznego relaunch/accept. Retencja caller_ping w panelu pozostaje osobnym punktem.
- [x] Zachować identyfikator bezpośredniego rodzica i sesji głównej.

Weryfikacja: opcjonalne strict-schema lineage zawiera rzeczywiste header IDs i canonical session paths rodzica, korzenia i dziecka; standalone nie kopiuje rozmowy, fork zachowuje własny header. Assignment/profile/manifest/result i closed/live resume zachowują oryginalne pochodzenie. Focused lineage/assignment/profile 19/19, lint OK; mockowane granice OS/Pi, bez live herdr. Foreign harness nie otrzymuje obietnicy dziedziczenia Pi ani zweryfikowanej tożsamości sesji.
- [x] Dodać krótką historię jawnych komunikatów, decyzji i zmian stanu.

Weryfikacja: root-owned subagent-history zawiera atomowe, immutable unique-event records (320 bajtów skrótu, maks. cztery refs), assignment/ping/result/failure/continuation oraz diff autorytatywnego PlanPersistence (status/accept/invalidate). Root odczytuje tylko zgodne aktywne natywne assignment/custody checkpoints, canonical root ID/file/token; bez pełnych rozmów, raportów ani reasoning i bez sendMessage/model wake dla descendant history. Focused lineage/history/runtime-execute/profile 13/13, lint OK; bez live herdr. Same-user fs trust, ograniczony odczyt, brak sandbox i gwarancji trwałości katalogu po awarii zasilania.
- [x] Dodać zwijane drzewo zagnieżdżonych podagentów bez kopiowania ich całych rozmów do rodzica głównego.

Weryfikacja: /subagents-tree toggle/expand/compact/toggle sessionId/refresh steruje osobnym natywnym widgetem opartym wyłącznie na autoryzowanych lineage/history, także bez procesów. Max 200 sesji/16 poziomów/120 linii, Unicode/narrow/cycles/missing parents. fs.watch uruchamiany dopiero session_start, shutdown zamyka watchery i timeout; zmiany potomków odświeżają wyłącznie UI, bez budzenia modelu. Test używa prawdziwego SessionManager, prawdziwych atomowych eventfiles i fs.watch oraz mockowanej granicy widget/komenda; testy command metadata obejmują fork/nested/closed resume. Nowe testy 6/6, focused wcześniejszy run 57/57; final pełny sequential 402/421, zero skip, wyłącznie 19 błędów bazowych (18 Claude/Python, 1 CRLF release), lint exit 0. Bez live herdr/provider E2E. Brak wsparcia fs.watch → ręczny/tool refresh; limity i zakres platform opisane w README.

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

- [x] Zlecenie: cel, zakres, kryteria akceptacji, zależności, potrzebne pliki/decyzje, ograniczenia zmian.
- [x] Wynik: wykonane/częściowe/zablokowane, podsumowanie, artefakty, sprawdzenia i rezultaty, niespełnione kryteria, ryzyka.
- [x] Powiązać dowody z kryteriami; samo pole `testsPassed` lub tekst „gotowe” nie wystarcza.
- [x] Zachować kompatybilność z wynikami tekstowymi; brak struktury nie może automatycznie oznaczać akceptacji.

### Polityka komunikatów

- [x] UI aktualizować bez dodatkowych tur modelu.

Weryfikacja: rzeczywiste registerPlanTools/store/session_start/session_tree i widget w test/plan-view.test.ts; jawne spy sendMessage/sendUserMessage odrzucają dodatkową pracę modelu przy mutacji i odtwarzaniu gałęzi. README rozdziela prezentację od projekcji kontekstu. Testy panelu: 9/9; bez live herdr.
- [x] Model budzić dla wyników, blokad, pytań i decyzji wymagających reakcji.

Weryfikacja: notification-policy.ts klasyfikuje jawne zdarzenia, delivery.ts stosuje politykę przed enqueue na produkcyjnej granicy outbox. Wyniki/ping/błędy zachowują waking steer, retry i dedup; pytanie/decyzja to kategorie polityki, nie nowe narzędzia. Testy notification-policy/delivery: 20/20; bez live herdr.
- [x] Zwykły postęp udostępniać w panelu lub zbiorczym skrócie zamiast strumienia powiadomień.

Weryfikacja: rzeczywisty callback status refresh nie wysyła subagent_status; aktualizuje lifecycle i istniejący widget zarówno autonomous, jak interactive, także stalled → active. Test produkcyjnej ścieżki sprawdza zmianę renderu i zero send, potem waking result/ping/error. Zachowano legacy renderer historii. Focused notification/delivery/keepOpen/recovery/panel: 35/35; bez live herdr.
- [x] Rozważyć niewymuszający zakończenia sesji kanał pytania/postępu dopiero po ustaleniu bezpiecznej kontynuacji żywego dziecka.

Decyzja: rozważono i odroczono, bez nowego narzędzia/protokołu. README porównuje exiting caller_ping z istniejącą guarded settled-idle continuation Pi/keepOpen, wskazuje wymagane correlation, trwałą blokadę, authority, cancellation/late answers, manual input i restart uncertainty. Bezpieczne resume jest warunkiem koniecznym, nie dowodem gotowości niezamykającego kanału pytań. Testy keepOpen/continuation/delivery pozostają wymaganym kontraktem.

Końcowa weryfikacja polityki: focused notification/delivery/keepOpen/continuation/ownership/recovery/panel/context 57/57, zero skip; lint bez ostrzeżeń. Pełny npm test: 399/418, zero skip, te same 19 bazowych błędów (18 brak Python/Claude, 1 regex CRLF release). Prawdziwy Pi RPC uruchomiony z izolowanym agentDir i jawnym -e rozszerzenia tego worktree: get_state success, exit 0, brak extension errors; bez wywołania modelu i bez live herdr. Pierwszy probe z domyślnym agentDir przekroczył 20 s bez odpowiedzi; izolowany probe rozdziela dowód załadowania od środowiska globalnego.

### Dopasowanie instrukcji ról

- [x] Zweryfikować zgodność wymaganych czynności z dostępnymi narzędziami; scout i reviewer proszą o zapis raportów, choć deklarują tylko `read, bash`.
- [x] Preferować sensowne, weryfikowalne jednostki pracy zamiast sztywnego wymogu zadań na 2–5 minut.
- [x] Uzależnić commitowanie od polityki projektu i polecenia użytkownika, nie od bezwarunkowego zamknięcia każdego todo.
- [x] Przekazywać ścieżki do artefaktów i celowane skróty zamiast wielokrotnego wklejania całych raportów.
- [x] Równoległych workerów modyfikujących kod wprowadzać dopiero z izolacją, np. worktree, i etapem integracji.

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

- [x] Wydzielać discovery, uruchamianie, dostarczanie i UI z `index.ts` przy okazji realizacji zmian, bez jednorazowego przepisywania całości.

Weryfikacja: `discovery.ts` przejmuje typy, parser, name-keyed discovery i katalog, z zachowaniem aliasów `__test__`, call-time cwd/config, CRLF i local override. Istniejące moduły launch/delivery/UI pozostają oddzielne; granice opisuje `ARCHITECTURE.md`. `node --test test/discovery.test.ts test/test.ts`: 185/185, bez skip; bez live herdr.
- [x] Współdzielić ścieżki spawn i resume oraz definicję manifestu uruchomienia.

Weryfikacja: wspólne `prepareLaunchRun`/`registerLaunchedRun` w obu produkcyjnych ścieżkach, typ wejścia wyprowadzony z istniejącego `DurableRun`, jeden RuntimeStore i zapisany LaunchProfile. Regresja execute porównuje pola rejestru z manifestem na dysku i profilami spawn/closed resume; dotychczasowe ownership/continuation dowodzą zachowania run/pane/watchera przy interrupt. Focused runtime-execute/ownership/profile/continuation/keep-open: 31/31, zero skip; lint exit 0. Bez nowego engine ani live herdr.
- [x] Określić jedno miejsce zatwierdzania zmian zadania; dzieci zgłaszają wyniki zamiast niezależnie nadpisywać wspólny stan.

Weryfikacja: audyt `plan-tools`/`plan-runtime` → ta sama instancja `PlanPersistence.mutate`, prywatny append snapshotów; nie znaleziono luki wymagającej drugiego store. `architecture-authority.test.ts` obserwuje rzeczywistą granicę narzędzi/importów, sprawdza odrzucenie child tool/import, stale revision, historical branch i starego authority z niezmienionymi bajtami pliku; wynik → review, nie accept. Focused authority/persistence/branches/runtime: 14/14, zero skip, w tym rzeczywisty lifecycle Pi z kontrolowanym providerem; lint exit 0. Granice i brak cross-process CAS/OS sandbox opisuje `ARCHITECTURE.md`.
- [x] Użyć natywnych mechanizmów Pi do widgetów i zapisów sesji tam, gdzie wystarczą; trwały transport wyników traktować oddzielnie od prezentacji.

Weryfikacja: `ARCHITECTURE.md` opisuje native custom plan entries/getBranch, widget oraz request-time context oddzielnie od RuntimeStore/outbox. Nowy integration regression `architecture-presentation.test.ts` łączy native storage, zarejestrowane UI/context, runtime import i trwałą dostawę: wyjątek send zachowuje accepted; refresh/render/reload/tree nie zmieniają bajtów obu store, outbox, append ani powiadomień; widget można odrzucić i odtworzyć z aktywnej gałęzi po reopen. Focused presentation/view/context/delivery/execute/capabilities: 36/36, zero skip; lint exit 0. Pełna enumeracja npm sekwencyjnie: 420/439, zero skip, wyłącznie 19 błędów bazowych (18 Python/Claude, 1 CRLF release). Bez live herdr; brak obietnic exactly-once, cross-process CAS czy OS sandbox.

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

- [x] Testy jednostkowe przejść stanów, deduplikacji, unikalności artefaktów i kontraktów ścieżek.
- [x] Testy odtwarzania planu, powtórnych prób, zależności, blokad oraz rozgałęzień sesji.
- [x] Testy renderowania dla długich planów, wąskich terminali i historii wyników.

Weryfikacja: `automated-render-boundary.test.ts` łączy rzeczywiste rejestracje panelu, historii i kart wyników z natywnym magazynem. Sprawdza szerokości 1–160 kolumn, Unicode/combining marks, 36 zadań, skrócenie szczegółów do 120 wierszy, cykle/osierocone węzły historii, zmianę motywu i gałęzi oraz brak zapisów i dodatkowych tur modelu. Rozwinięta karta pokazuje ograniczony podgląd strukturalnej propozycji niezależnie od tekstowej odpowiedzi; nie certyfikuje dowodów. Testy tekstowego renderera nie zastępują screenshotów ani live E2E.
- [x] Testy live: równoległy spawn, wynik podczas reloadu, interrupt/kontynuacja/resume, wybrana semantyka keepOpen.

Akceptacja rodzica: niezależnie od raportu wykonawcy sprawdzono `assertions.json` i `cleanup.json` wszystkich pięciu końcowych, uwierzytelnionych prób Pi TUI/HC oraz zgodność 60 hashy aktualnych źródeł z `source-manifest.json`. Cztery próby lifecycle potwierdzają równoległy spawn z wynikiem w rzeczywistym, instrumentowanym oknie reloadu, closed resume, dwa wyniki keepOpen w tej samej sesji i interrupt → kontynuację tego samego procesu. Cała końcowa komenda: 5/5, zero błędów i pominięć. Szczegóły i granice: `test/integration/HC-TUI-VERIFICATION.md`; prywatne dowody `.git/verification/2026-11-14-final-main-confirmation/summary.json`. Wcześniejsze nieudane próby zachowano, nie policzono ich jako zaliczonych. Dowód dotyczy Pi/HC i wskazanego modelu, nie wszystkich harnessów ani wizualnego wyglądu.
- [ ] Testy restartu i odtworzenia nadzoru, jeśli taka gwarancja zostanie wdrożona.
- [x] Testy możliwości wspieranych harnessów; jawne odrzucanie nieobsługiwanych operacji.

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
