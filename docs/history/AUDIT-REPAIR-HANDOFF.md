# Ustalenia audytu — przekazanie do sesji naprawczej

## 1. Status i przeznaczenie dokumentu

**Aktualizacja naprawcza 2026-11-16:** po osobnym zleceniu użytkownika wdrożono R1–R6 oraz M9–M11. Końcowe testy offline na lokalnym Pi 1.5.2: **712/712**, bez pominięć; lint i `npm audit` (0 podatności) przechodzą. Szczegóły, zmiany kontraktów i ograniczenia: [test/AUDIT-REPAIR-VERIFICATION.md](../../test/AUDIT-REPAIR-VERIFICATION.md). Globalnej instalacji Pi nie zaktualizowano; live herdr/provider e2e pozostaje niewykonane.

**Historyczny status sesji audytu:** ustalenia zostały zweryfikowane, ale wówczas nie implementowano napraw — zlecono tylko zapis raportu. Poniższe reprodukcje i checklisty opisują punkt wyjścia oraz kryteria; bieżącym dowodem wykonania jest raport weryfikacji powyżej. Dokument nadal nie jest zgodą na uruchamianie procesów z historycznych sesji ani dowodem ich aktualnej aktywności.

Audyt dotyczył całego ówczesnego drzewa roboczego, również zmian niezacommitowanych, przy HEAD `d226f33bbe8b7c4f429cb959898259a5e064485c`. Numery linii są orientacyjne; przy implementacji wyszukiwać również wskazane funkcje. Jeżeli kod się zmienił, najpierw ponownie potwierdzić problem.

Dokument jest **uzupełnieniem**, nie zastępstwem:
- [BACKLOG.md](../../BACKLOG.md) — wcześniejszy zbiorczy status;
- [SUBAGENT-REPAIR-PLAN.md](SUBAGENT-REPAIR-PLAN.md) — wcześniejsze naprawy, częściowo już oznaczone jako wykonane;
- [SUBAGENT-CONTEXT-OPTIMIZATION-PLAN.md](SUBAGENT-CONTEXT-OPTIMIZATION-PLAN.md) — osobny zakres optymalizacji;
- [test/REPAIR-VERIFICATION.md](../../test/REPAIR-VERIFICATION.md) — wcześniejsze dowody i ograniczenia.

Nie otwierać ponownie wszystkich historycznych punktów tylko dlatego, że ich opisy przypominają poniższe usterki. Przykładowo `terminate: true` w `caller_ping` już istnieje; osobnym problemem jest **moment publikacji wyniku względem pozostałych narzędzi batcha**.

## 2. Cel rozszerzenia i ograniczenia napraw

Rozszerzenie służy do delegowania pracy do specjalistów w osobnych terminalach herdr, pracy równoległej oraz interaktywnej współpracy użytkownika z dziećmi. Rodzic otrzymuje wyniki automatycznie, bez modelowego odpytywania o status. Obsługiwane są różne tryby dziedziczenia kontekstu, interrupt/resume/close, keep-open, trwałe wyniki, plany i checkpointy.

**To nie jest sandbox.** Wspólny filesystem, pełne uprawnienia procesu, Bash i jawnie zaufane polecenia agentów mogą być zamierzoną funkcjonalnością. Naprawy nie powinny:
- usuwać projektowych definicji agentów, forków ani interaktywności;
- zakazywać użytkownikowi `/new`, `/resume` lub `/fork` w terminalu dziecka;
- wiązać całego życia zaakceptowanego dziecka z sygnałem krótkotrwałego wywołania narzędzia;
- uznawać braku aktywności za zakończenie procesu lub przyjęcie zadania;
- osłabiać custody, PID/birth, revision/authority, immutable events ani kontroli draft/pending input;
- usuwać dowodów lub bieżącego stanu z kontekstu tylko dla poprawy cache;
- przepisywać całej architektury bez konkretnej potrzeby.

Zasada przewodnia: **swoboda agenta jest funkcją; przypadkowa interpretacja danych jako poleceń, utrata wyniku i pomylenie tożsamości zadania są błędami.**

## 3. Weryfikacja wykonana podczas audytu

- Lokalne `@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`: **1.3.0**.
- Node **24.21.0**, npm **11.19.0**, Windows.
- `npm test`: **626/626**, zero błędów, pominięć i anulowań; raportowany czas 236 708 ms. To czas testów, nie benchmark narzutu rozszerzenia.
- `npm run lint`: exit 0.
- Brak skryptu typecheck i lokalnego kompilatora; pełnego typecheck nie wykonano.
- Dokumentacja i rzeczywista implementacja Pi sprawdzone lokalnie, zwłaszcza lifecycle, parser CLI, trust i virtual models.
- Reprodukcje generowania poleceń nie wykonywały wygenerowanej powłoki. Dodatkowe próby używały in-memory managers oraz zamockowanego FS/transportu.
- Zestaw testów zawiera izolowane procesy offline Pi/SDK. Nie testowano zewnętrznego modelu, rzeczywistych terminali herdr ani historycznych sesji użytkownika.
- Audyt nie zmienił implementacji. Drzewo miało wiele wcześniejszych zmian; nie resetować ich.

Przed zmianą kodu przeczytać dokumentację i przykłady **faktycznie używanej wersji Pi**, zwłaszcza `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`, `docs/session-format.md`, `docs/virtual-models.md` oraz odpowiednie typy/runtime. Nie zakładać zgodności innej wersji API.

## 4. Kolejność prac

| Pakiet | Priorytet praktyczny | Rezultat |
|---|---|---|
| R1 | Najwyższy | Zakończenie zadania nie wyprzedza trwającej pracy |
| R2 | Najwyższy | Nowa sesja dziecka nie kończy starego zadania |
| R3 | Wysoki | Wyniki i supervision nie giną po błędzie I/O |
| R4 | Wysoki | Nazwy i zadania pozostają danymi w shell/CLI |
| R5 | Wysoki przed szerszą dystrybucją | Jawny, konsekwentny kontrakt zaufania projektu |
| R6 | Następny po poprawności | Koszt długiej sesji nie narasta przez ponowne przetwarzanie całej historii |

R1–R4 są błędami funkcjonalnymi niezależnie od tego, czy użytkownik pracuje wyłącznie w zaufanych repozytoriach. R5 wymaga także decyzji produktowej o dozwolonych źródłach konfiguracji. Ekspozycja bezpieczeństwa R5 jest mniejsza w środowisku wyłącznie zaufanych checkoutów, ale niejawne obchodzenie odmowy trust pozostaje problemem kontraktu.

## R1. Publikować zakończenie dopiero po rzeczywistym settlement

**Odniesienie do audytu:** H6.

**Miejsca:**
- `pi-extension/subagents/subagent-done.ts:334–358`: `subagent_done.execute()`, `completionDelivered`, `writeRunCompletion()`, `ctx.shutdown()`;
- `pi-extension/subagents/subagent-done.ts:202–226`: istniejący handler `agent_settled` dla automatycznego zakończenia;
- `pi-extension/subagents/index.ts:1337–1457`: `watchSubagent()`, odczyt completion i `safeClose()`;
- sprawdzić analogiczną przedwczesną publikację `caller_ping` w `subagent-done.ts`.

**Problem i dowód:** jawny `subagent_done` publikuje completion wewnątrz wykonania narzędzia. Jeśli w tym samym batchu jest wolny zapis/inne narzędzie, rodzic może już przeczytać sidecar i zamknąć pane. Pi 1.3.0 wymaga, by wszystkie wyniki batcha miały `terminate: true`, aby batch zatrzymał dalszą pętlę (`pi-agent-core/dist/agent-loop.js`, `shouldTerminateToolBatch()`). Samo `ctx.shutdown()` jest odroczonym żądaniem, nie dowodem settlement. Przy `close:false` wczesne `completionDelivered` może stłumić późniejszy wynik.

**Kierunek:** stage jawnego zamiaru completion/ping i publikacja na właściwej granicy `agent_settled`. Nie wystarczy zmienić opisu narzędzia na „wywołuj osobno” ani dodać `executionMode` bez sprawdzenia realnej pętli Pi. Ustalić, kiedy pobierane jest finalne podsumowanie i jak raportowany jest błąd siblinga.

**Akceptacja:**
- [ ] Native Pi + kontrolowany provider: `subagent_done` i wolny sibling w jednej odpowiedzi nie publikują completion przed zakończeniem siblinga.
- [ ] Rodzic nie zamyka pane podczas pracy siblinga.
- [ ] Przetestowane `close:true`, `close:false`, automatyczne zakończenie i błąd/anulowanie siblinga.
- [ ] Końcowy wynik nie jest zastępowany starym/pustym podsumowaniem; zdarzenie publikowane raz.
- [ ] Zdefiniowana i przetestowana semantyka mieszanej grupy z `caller_ping`.

**Testy startowe:** `test/caller-ping-loop.test.ts`, `test/keep-open.test.ts`, `test/completion-turn.test.ts`, `test/child-session.ts`, `test/ownership-execute.test.ts`.

## R2. Powiązać completion z właściwą sesją i zadaniem

**Odniesienie do audytu:** H7.

**Miejsca:**
- `pi-extension/subagents/run-artifacts.ts:14–47`: `beginCompletionTurn()`, `writeRunCompletion()`;
- `pi-extension/subagents/subagent-done.ts`: `session_start`, `before_agent_start`, `agent_settled`, jawne narzędzia completion;
- jako przykład istniejącej kontroli tożsamości: `recovery-identity.ts` oraz `close-control.ts` (session path + header ID).

**Problem i dowód:** po `/new`, `/resume` lub `/fork` środowisko nadal wskazuje pierwotny `PI_SUBAGENT_SESSION`. `writeRunCompletion()` przy niezgodności sesji wybiera puste `entries`, lecz nadal publikuje `done` pod ścieżką starego runu. Próba in-memory z `replacement.jsonl` potwierdziła publikację pod starym celem. Rodzic może uznać niezwiązane zadanie za zakończone i zamknąć terminal nowej sesji. Nie jest to automatyczna akceptacja planu, ale korelacja wyniku jest błędna.

**Kierunek:** oddzielić tożsamość procesu, bieżącej sesji i nadzorowanego zadania. Walidować kanoniczną ścieżkę i header identity przed publikacją; jawnie określić zachowanie nadzoru po zmianie sesji. Nie rozwiązywać problemu blokadą interaktywnych operacji użytkownika.

**Akceptacja:**
- [ ] Po `/new`, `/resume`, `/fork` niezwiązana odpowiedź nie publikuje sukcesu starego zadania i nie zamyka nowej sesji.
- [ ] `/reload` tego samego dziecka zachowuje poprawną tożsamość i supervision.
- [ ] `/tree` respektuje uzgodnioną semantykę aktywnej gałęzi; nie odczytuje starego wyniku jako nowego.
- [ ] Przypadki normalnego completion, ping, keep-open i closed/live resume nadal działają.
- [ ] Test sprawdza target zdarzenia i reakcję rodzica, nie tylko treść podsumowania.

**Testy startowe:** `test/completion-turn.test.ts`, `test/late-continuation.test.ts`, `test/live-continuation-native.test.ts`, `test/runtime-recovery.test.ts`.

## R3. Nie gubić wyników i nadzoru po błędach I/O

**Odniesienia do audytu:** M1–M3. To trzy osobne ścieżki wymagające testów.

### R3a. Bezpieczny callback błędu continuation

**Miejsce:** `pi-extension/subagents/live-continuation.ts:36–58`, `registerLiveContinuation()`, `busy()` i callbacki `watch()`/`error`.

Callback po błędzie zamyka watcher, a następnie wywołuje `busy()`, które bez ochrony zapisuje na ten sam potencjalnie uszkodzony dysk. Zamockowany `ENOSPC` wyszedł jako wyjątek z natywnego callbacku Node, poza ochroną handlerów Pi.

**Naprawa:** cleanup niezależny od zapisu. Ewentualny zapis diagnostyki osobno zabezpieczony; zachować fence niepewnego dispatch i brak automatycznego replay.

### R3b. Pending completion po nieudanym zapisie keep-open

**Miejsce:** `pi-extension/subagents/subagent-done.ts:214–223`, handler `agent_settled`.

Wyjątek `writeRunCompletion()` jest połykany, lecz `completionDelivered` nadal staje się `true`. Przy keep-open nie ma później shell exit/sentinela. Reprodukcja awarii, odzyskania storage i kolejnego settlement nie spowodowała publikacji.

**Naprawa:** zachować nieopublikowany wynik i jawny błąd; oznaczać lokalną publikację dopiero po powodzeniu. Zaprojektować ograniczone, obserwowalne ponowienie, bez dodatkowych tur modelu i bez nadpisywania niezmiennych dowodów.

### R3c. Widoczna awaria recovered supervision

**Miejsce:** `pi-extension/subagents/runtime-recovery.ts:95–98`, interwał w `reconcileRuntime()`; odbiorca w `pi-extension/subagents/index.ts:587–601`, `recoverParentRuntime()`.

`catch { stopped = true; clearInterval(timer); }` wyłącza zbieranie wyników bez zgłoszenia rodzicowi. Dotyczy późniejszego interwału, więc startupowy catch tego nie przechwyci.

**Naprawa:** callback błędu, jawny paused/error i możliwość eksplicytnego reconciliation. Nie wznawiać automatycznie pracy po utracie custody i nie relaunchować dzieci.

**Wspólna akceptacja:**
- [ ] `ENOSPC`, `EACCES`, `EIO` w watcherze i harvesting nie powodują uncaught exception.
- [ ] Rodzic/użytkownik widzi, że wynik lub supervision są pending/paused/uncertain.
- [ ] Odzyskanie storage i kontrolowane ponowienie dostarcza dokładnie jeden logiczny wynik.
- [ ] Nie ma fałszywego `delivered`, utraty immutable event ani replay niepewnego dispatch.
- [ ] Jedna awaria nie zatrzymuje wszystkich odzyskanych runów bez diagnostyki.

**Testy startowe:** `test/live-continuation.test.ts`, `test/keep-open.test.ts`, `test/delivery.test.ts`, `test/runtime-recovery.test.ts`, `test/dispatch-failure.test.ts`.

## R4. Zachować literalność danych przy generowaniu shell i argumentów Pi

**Odniesienia do audytu:** H3–H5. Nie chodzi o odebranie agentowi Basha, tylko o niezamierzone wykonanie danych na innej warstwie.

### R4a. Metadane w komentarzu skryptu

**Miejsca:** `pi-extension/subagents/terminal.ts:132–134`, `runScriptInPane()`; `harness/drivers/pi.ts:188–194` i odpowiedniki w `claude.ts`, `codex.ts`, `opencode.ts`, `grok.ts`, `generic.ts`; fallback w `index.ts:1299–1303`.

Nazwa `Worker\nprintf AUDIT_MARKER\n#` tworzy samodzielną wykonywalną linię w preamble. Sanitizacja nazwy pliku nie chroni treści skryptu.

**Naprawa:** usunąć niezaufane metadane z wykonywalnego skryptu albo komentować każdą fizyczną linię, najlepiej przez wspólny helper. Objąć też metadane ścieżek i closed resume, nie tylko `name`.

### R4b. Kaskadowa ekspansja placeholderów

**Miejsce:** `pi-extension/subagents/harness/drivers/generic.ts:60–66`, `GenericHarnessDriver.buildCommand()`.

Łańcuch `.replace()` ponownie interpretuje placeholdery w podstawionych danych. Dla szablonu `custom {task}`, zadania `{name}` i nazwy `x; printf AUDIT_TEMPLATE; echo ` kolejne podstawienie uszkadza wcześniejsze shell quoting i ujawnia separatory.

**Naprawa:** jedno podstawienie jednym regexem/mapą, bez ponownego przetwarzania wartości. Jawnie zaufany szablon nadal może być wykonywalną konfiguracją.

### R4c. Zadanie jako flagi/załączniki CLI

**Miejsca:** `pi-extension/subagents/harness/drivers/pi.ts:129–137,173–177`, `PiHarnessDriver.buildCommand()`, `buildPiPromptArgs()`; `launch-profile.ts`, `resumeLaunchContext()` dla dostawy `direct`.

W bare fork/direct resume zadanie `--approve` jest opcją trust, `--no-session` zmienia persistence, a `@/path/file` jest załącznikiem. Zainstalowany `dist/cli/args.js` potwierdził, że `@file` jest interpretowane również po `--`.

**Naprawa:** literalna dostawa zadania przez kontrolowany artefakt lub właściwe API. Samo shell quoting i samo `--` nie wystarczą. Zachować jeden kompletny input zadania/skillów, bez dodatkowej tury rozruchowej i bez utraty instrukcji roli.

**Wspólna akceptacja:**
- [ ] Wieloliniowe nazwy/metadane pozostają komentarzami we wszystkich driverach, także resume.
- [ ] `{name}`, `{cwd}`, `{task}` i inne placeholdery wewnątrz wartości pozostają literalne.
- [ ] Cudzysłowy, apostrofy, `$`, Unicode, newline i separatory nie opuszczają argumentu danych.
- [ ] `--approve`, `--no-session`, `@file` docierają do modelu jako tekst zadania, bez zmiany opcji i bez niejawnego odczytu pliku.
- [ ] Przetestowane standalone/lineage-only/fork oraz live i closed resume; bez dodatkowych requestów modelu.

**Testy startowe:** `test/harness-drivers.test.ts`, `test/role-delivery.test.ts`, `test/initial-skills.test.ts`, `test/launch-profile.test.ts`, `test/terminal-queries.test.ts`.

## R5. Jawny kontrakt zaufania projektu, bez usuwania projektowych agentów

**Odniesienia do audytu:** H1–H2. Najpierw doprecyzować politykę użytkownika, następnie egzekwować ją konsekwentnie.

### R5a. Automatyczny wybór repozytoryjnego agentDir

**Miejsca:** `pi-extension/subagents/index.ts:238–248`, `resolveSubagentPaths()`; `harness/drivers/pi.ts:114–116`, ustawienie `PI_CODING_AGENT_DIR`.

Samo istnienie `<cwd>/.pi/agent` awansuje ten katalog do konfiguracji użytkownika dziecka. Pi 1.3.0 ładuje user extensions także podczas bootstrapu trust (`dist/core/resource-loader.js:349–365`, `dist/core/package-manager.js:2054–2055`). Projektowe `.pi/agent/extensions` nie podlega wtedy projektowej odmowie trust.

**Kierunek:** zachować zaufany agentDir rodzica jako bezpieczną bazę. Użycie lokalnego agentDir może pozostać funkcją, lecz powinno wymagać jawnej zgody/konfiguracji dla konkretnego źródła. Sam parametr `cwd` nie jest jednoznaczną zgodą na user-level extensions.

### R5b. Discovery i lookup projektu

**Miejsca:** `pi-extension/subagents/discovery.ts:110–127`, `discoverAgentDefinitions()`/`loadAgentDefaults()`; wywołania w `index.ts:1154,1574–1575` i komendach/preflight.

Projektowe definicje nadpisują globalne i mogą sterować `cli`/`command-template`, bez konsultacji `ctx.isProjectTrusted()`. Samo `.pi/agents` nie wyzwala standardowego pytania Pi: `dist/core/trust-manager.js`, `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES`; bez rozpoznanych zasobów host może zwrócić trusted automatycznie. Dlatego samo dodanie jednego sprawdzenia bool może nie rozstrzygać, czy użytkownik świadomie zaakceptował wykonywalne definicje.

**Kierunek:** wybrać i udokumentować kontrakt dla executable project definitions oraz agents-only checkoutów. Przekazywać autoryzowany cwd/trust do discovery i ponownie walidować źródło przed dispatch. Nie polegać wyłącznie na etykiecie `[project]`, cache katalogu lub `process.cwd()`.

**Akceptacja:**
- [ ] Odmowa trust nie jest obchodzona przez agentDir ani przez same-name override.
- [ ] Agents-only checkout ma jawnie uzgodnioną politykę, sprawdzoną testem.
- [ ] Zaufane projektowe role, niestandardowe polecenia i role-specific cwd nadal działają.
- [ ] Sprawdzane są bieżące źródło i uprawnienie przed startem, również przy innym target cwd i resume.
- [ ] Próba testowa niezaufanego user-level rozszerzenia nie wykonuje payloadu w rzeczywistym profilu użytkownika.

**Testy startowe:** `test/discovery.test.ts`, `test/ownership-execute.test.ts`, `test/launch-profile.test.ts`, `test/runtime-execute.test.ts`; nowy izolowany test trust/bootstrap.

## R6. Ograniczyć narzut długich sesji, zachowując dowody

**Odniesienia do audytu:** M7–M8.

### R6a. Completion files, cursor i runtime manifest

**Miejsca:**
- `pi-extension/subagents/completion.ts:95–101`, `consumeExitSidecar()`/`readRetainedCompletion()`;
- `pi-extension/subagents/index.ts:1354`, callback `retainedEventIds`;
- `pi-extension/subagents/runtime-store.ts:148`, `snapshot()`;
- `pi-extension/subagents/index.ts:1522–1538`, `delivery.onEnvelope`, `retryPlanImports()`;
- analogiczne odczyty w `runtime-recovery.ts`, `harvest()`.

Każdy poll odczytuje historyczne pliki JSON, a membership cursor jest liniowym `includes()`. Pobranie cursora klonuje cały manifest. Reconciliation przegląda ponownie cały outbox i robi kolejne pełne kopie dla lookupów.

**Dowód:** 1000 już przetworzonych plików i zero nowych zdarzeń dały 1000 synchronicznych `readFileSync` na jeden pusty poll. To pomiar liczby operacji w mocku, nie czas rzeczywistego dysku.

**Kierunek:** małe read-only selektory store, membership `Set`, indeks/cache odróżniający nieprzetworzone pliki oraz retry tylko nowych/błędnych importów. Pełny restoration nadal potrzebny na odpowiednich granicach. Nie usuwać historycznych dowodów ani nie osłabiać walidacji gałęzi.

### R6b. Hashowanie niepowiązanej historii

**Miejsce:** `pi-extension/subagents/context-publication.ts:20–40`, `latestIdentity()` i wywołania trzech kanałów publikacji.

`marker?.contentHash === digest(message.content)` liczy `digest()` także przy braku marker. Każdy kanał ponownie hashuje argumenty zwykłych narzędzi i wyniki. To CPU/alokacje lokalne, nie dodatkowe tokeny modelu.

**Kierunek:** sprawdzać marker i kanał przed kosztownym hashem; ewentualnie współdzielić zweryfikowane hashe w obrębie jednej projekcji. Zachować wykrywanie edycji treści, usuniętej pary call/result i przerwanego łańcucha receipts.

**Wspólna akceptacja:**
- [ ] Pusty poll nie czyta ponownie wszystkich poprawnie zatwierdzonych event payloadów.
- [ ] Dodanie nowego eventu, restart, reload, korupcja pliku i fail/retry importu nie gubią wyników i nie powodują duplikacji.
- [ ] Receipt-free tool results nie są hashowane bez potrzeby.
- [ ] Testy widoczności/edycji kontekstu i wszystkich kanałów publikacji nadal przechodzą.
- [ ] Pomiary rozdzielają liczbę operacji, czas, CPU/heap i rozmiar danych. Nie raportować oszczędności tokenowych za samo ograniczenie lokalnego I/O.

**Testy startowe:** `test/resume-safety.test.ts`, `test/runtime-recovery.test.ts`, `test/runtime-store.test.ts`, `test/plan-import-publication.test.ts`, `test/context-publication.test.ts`, `test/architecture-presentation.test.ts`.

## 5. Druga kolejność i usprawnienia opcjonalne

Nie wszystkie poniższe punkty są blockerem docelowego workflow TUI. Wybrać je według używanych funkcji i oddzielić od R1–R6.

| Punkt audytu | Miejsce | Co poprawić i jak sprawdzić |
|---|---|---|
| M9: abort przed dispatch | `index.ts:1711,1756,2139`, `launchSubagent()` i delay | Sprawdzać signal przed przygotowaniem i tuż przed dispatch, stosować anulowalny delay. Już anulowany sygnał w mocku nadal dał jeden dispatch i `started`. Nie anulować zaakceptowanego dziecka po zwykłym powrocie narzędzia. |
| M10: legacy timeout | `herdr.ts:125–127`, `herdrExec()` | Synchroniczny `execFileSync` nie ma timeoutu. Ograniczyć blokadę i zachować unknown po niepewnym dispatch. Test zawieszonego CLI; nie mylić z async queries, które mają limit 4 i timeout 15 s. |
| M4: duży task | `plan-tools.ts:58–65,93–99`, `response()`, `plan_read.execute()` | Sekcje/paginacja. Sam `taskId` nadal kończy się limitem 40 KB/2000 linii i wskazówką powtórzenia tego samego wywołania. Test pełnej enumeracji wyników/evidence/decisions. |
| M5: uszkodzony porzucony detach | `plan-persistence.ts:74–76`, `historical()` | Walidować `source.authority` przed dereferencją. Nieprawidłowy potomek nie może ukryć poprawnego aktywnego snapshotu; konserwatywny read-only zamiast TypeError. |
| M6: virtual models Pi | `context-guard.ts:80–81,105–106,132–135` | Limity z efektywnego usage; summary przez routowane `streamSimple(...).result()` z dodatnim budżetem. `complete()` nie routuje virtual. Dotyczy modeli zarejestrowanych jako virtual, nie każdego modelu nazwanego `auto`. Test limitów nieznanych i innych niż fizyczny target. |
| M11: zależności | `package.json`, `package-lock.json` | W audycie: `undici@8.10.2`, advisories dla `<8.12.2`; `minimatch@10.2.6`, GHSA-g3hv-75wg-m249 dla `<11.0.1`. Ponowić `npm audit`, wybrać kompatybilną aktualizację hosta i regresję. Nie wszystkie advisories mają potwierdzoną osiągalność przez rozszerzenie; nie wykonywać ślepo force-fix. |
| L1: host SDK | `live-continuation.ts:45–58` | `watcher.unref()` + normalny cleanup. Pi `AgentSession.dispose()` nie emituje shutdown; test naturalnego zakończenia izolowanego SDK hosta. Niższy priorytet, jeśli produkt używa tylko CLI. |
| L2: snippets | `index.ts`, definicje `subagent`, `subagent_resume`, interrupt/list | Skrócić `promptSnippet`, nie usuwać potrzebnych reguł. `subagent` i resume dublują odpowiednio 861/856 bajtów UTF-8 opisu. Bajty to nie tokeny ani cena. |
| INFO: payload metrics | `payload-diagnostics.ts`, `providerPayloadBytes()` | Opcjonalne/on-demand liczenie całego JSON zamiast stałego narzutu, jeśli metryki niepotrzebne. Nie przedstawiać tych liczb jako final-wire lub hard gate. |
| INFO: CI/moduły | workflow publikacji, duży `index.ts` | Pinning akcji do SHA i mniejsze uprawnienia jobów; ekstrakcje tylko przy praktycznej korzyści. Brak uzasadnienia dla całościowego rewrite. |

## 6. Zasady testowania i zakończenia prac

1. Przed edycją zachować zastany working tree; nie resetować ani nie commitować cudzych zmian bez zgody.
2. Dla każdej naprawy: najpierw regresja odtwarzająca problem, następnie minimalna zmiana i weryfikacja właściwego kontraktu Pi.
3. Lifecycle sprawdzać rzeczywistym schedulerem Pi z deterministycznym providerem, nie samym spy na `shutdown()`.
4. Shell/CLI testować izolowanie, z mockiem transportu/FS. Nie wykonywać payloadów na rzeczywistych terminalach ani prywatnych sesjach.
5. Po integracji uruchomić `npm run lint` i `npm test`; dopiąć nowe pliki testowe do skryptu, jeśli nie są automatycznie odkrywane.
6. Brak testu nie jest sam w sobie dowodem usterki; przejście dotychczasowych 626 testów nie zamyka nowych reprodukcji.
7. Live e2e wykonywać dopiero po preflight i sprawdzeniu skutków zgodnie z `.pi/skills/run-integration-tests/SKILL.md`. Nie deklarować live herdr/provider verification po samych testach offline.
8. Oddzielać: publikacja na dysku, synchronous handoff `sendMessage`, zużycie przez model, zakończenie procesu i akceptacja zadania. Żadne nie jest automatycznym dowodem pozostałych.
9. Nie dodawać globalnych kolejek mutacji bez konkretnego wyścigu. Istniejące synchroniczne granice planu, sequential tool i runtime leases mają pozostać źródłem ochrony.
10. Aktualizować status R1–R6 dopiero z konkretnymi testami, opisem zachowanych gwarancji i limitami weryfikacji. Osobno aktualizować wcześniejszy backlog; sam ten raport nie zmienia statusu wcześniejszych prac.

## 7. Proponowany start nowej sesji

> Przeczytaj `AUDIT-REPAIR-HANDOFF.md`, `BACKLOG.md` i odpowiednie wcześniejsze plany. Sprawdź aktualny working tree oraz używaną wersję Pi. Nie resetuj istniejących zmian. Najpierw potwierdź R1 i R2 w bieżącej implementacji oraz zaproponuj minimalny plan i testy regresji. Zachowaj interaktywność, keep-open i mechanizmy custody. Przed implementacją przeczytaj właściwe dokumenty i przykłady API Pi. Ten raport nie upoważnia do uruchamiania historycznych sesji ani live integracji; implementację rozpocznij po uzgodnieniu zakresu z użytkownikiem.
