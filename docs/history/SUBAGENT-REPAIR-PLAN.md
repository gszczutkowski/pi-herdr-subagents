# Plan napraw obsługi podagentów

## Status i zakres

Dokument zapisuje ustalenia przeglądu bieżącego drzewa roboczego, obejmującego również istniejące niezacommitowane zmiany. **Implementacja w toku na gałęzi `fix/subagent-repair-sequence`.** Stan zaznaczonych punktów odnosi się do testów lokalnych; testy rzeczywistych terminali herdr pozostają niewykonane (brak herdr w bieżącym środowisku). Bieżący zbiorczy status i zależności: [BACKLOG.md](../../BACKLOG.md); końcowe dowody: `test/REPAIR-VERIFICATION.md`.

Zakres: przekazywanie kontekstu, instrukcji i wyników; uruchamianie i kończenie pracy; przerywanie, wznawianie oraz zgodność z planem rodzica. To lista usterek i kryteriów naprawy, nie zapis stanu uruchomionych agentów ani zamiennik istniejącego planu rozwoju.

Numery linii odnoszą się do kodu z chwili przeglądu i mogą się przesunąć. Przy implementacji należy kierować się również wskazanymi funkcjami.

## Proponowana kolejność

1. **Przekazywanie zadania i zatrzymanie wykonania:** punkty 1–3.
2. **Bezpieczne i spójne wznawianie:** punkty 4–6 oraz 9.
3. **Poprawność informacji widocznych dla modelu:** punkty 7–8 oraz 10.

Każda naprawa powinna zawierać test regresji odtwarzający opisany problem. Nie wystarczy sprawdzenie zawartości argumentów CLI lub samo wywołanie `shutdown()` — tam, gdzie to istotne, trzeba sprawdzić rzeczywisty kontekst modelu i przebieg pętli agenta.

## 1. Fork przekazuje historię niewłaściwej gałęzi

- [x] Naprawić wybór kontekstu przy `fork`.
- [x] Dodać test regresji z rozgałęzioną sesją.

Wdrożono: fork otrzymuje `getBranch()` aktywnego rodzica, zachowuje surowe wpisy i identyfikatory przed ostatnią wiadomością użytkownika (bieżąca tura delegująca nie jest dziedziczona). Bez jawnej gałęzi odrzuca operację. `test/fork-context.test.ts` sprawdza natywny kontekst Pi dla sesji liniowej, rozgałęzionej, kompakcji, retain-none i nowego korzenia. Testy fork/lineage/test.ts: 195/195 OK.

**Miejsce:** `pi-extension/subagents/session.ts:22–45`, `getForkContentLines()`; wywołanie `seedSubagentSessionFile()` w `pi-extension/subagents/index.ts`.

**Problem:** kopiowany jest fizyczny fragment JSONL przed ostatnią wiadomością użytkownika, zamiast kontekstu aktywnej gałęzi. Po przejściu z gałęzi A na B dziecko może dostać porzuconą rozmowę A. Reprodukcja z natywnym `SessionManager` potwierdziła różne gałęzie w kontekście rodzica i dziecka.

**Kierunek naprawy:** przekazywać do mechanizmu forkowania wybraną gałąź/punkt sesji rodzica. Nie wyznaczać jej na podstawie fizycznego końca pliku. Osobno określić, jaka część bieżącej tury delegującej ma być dziedziczona; zachować prawidłowe powiązania wpisów i semantykę kompakcji.

**Kryteria akceptacji:**
- Fork po zmianie gałęzi nie zawiera wiadomości z porzuconej ścieżki.
- Kontekst odczytany przez natywne SDK odpowiada wybranej ścieżce i ustalonej granicy forkowania.
- Zachowanie jest sprawdzone dla sesji liniowej, rozgałęzionej i po kompakcji.

## 2. Skille i zadanie są wykonywane jako osobne tury

- [x] Przekazywać wymagane skille razem z właściwym zadaniem.
- [x] Sprawdzić kolejność rzeczywistych żądań do modelu oraz auto-exit.

Wdrożono: jeden argument zadania; skille rozwijane w hooku wejścia dziecka z jego faktycznie odkrytych zasobów. Brak wymaganego skilla blokuje zadanie i publikuje błąd. Test natywnego CLI parsera/plików i Pi AgentSession sprawdza dwa skille + zadanie w pierwszym żądaniu oraz auto-exit, bez dodatkowych tur. Zestaw skills/assignment/launch-profile/test.ts: 209/209 OK.

**Miejsce:** `pi-extension/subagents/harness/drivers/pi.ts:31–48`, `buildPiPromptArgs()`.

**Problem:** osobne pozycyjne argumenty CLI są przetwarzane jako kolejne wiadomości. Przy przekazaniu zadania przez artefakt zadanie trafia przed skillami. Przy przekazaniu bezpośrednim, używanym przez `fork`, pierwszy skill trafia przed zadaniem. Autonomiczny agent może zakończyć pracę po pierwszej turze, zanim otrzyma pozostałe wejścia.

**Dowód:** w reprodukcji z natywnym SDK i kontrolowanym modelem pierwsze żądanie zawierało tylko rozwinięty skill. Nastąpiło żądanie zamknięcia, podczas gdy właściwe zadanie nadal pozostawało niewysłaną wiadomością CLI.

**Kierunek naprawy:** przygotować jedno kompletne wejście dla zadania zawierające wymagane instrukcje skillów, bez dodatkowych tur rozruchowych. Zachować poprawną obsługę wielu skillów i ścieżek do artefaktów.

**Kryteria akceptacji:**
- Pierwsze żądanie do modelu zawiera zadanie i wszystkie wymagane skille.
- Dotyczy to zarówno `standalone`/`lineage-only`, jak i `fork`.
- Auto-exit nie następuje po samym wczytaniu skilla.
- Test obejmuje co najmniej dwa skille oraz oba sposoby dostarczenia zadania.

## 3. `caller_ping` nie zatrzymuje pętli agenta

- [x] Zakończyć pętlę po zgłoszeniu prośby o pomoc.
- [x] Dodać test z rzeczywistą pętlą agenta i kontrolowanym strumieniem odpowiedzi.

Wdrożono `terminate: true`. `test/caller-ping-loop.test.ts`: 3/3 OK, natywna pętla Pi, jedno niezmienne zdarzenie ping. Semantyka mieszanej grupy jest natywna: zatrzymanie bez kolejnego żądania następuje tylko gdy wszystkie wyniki są terminujące. Mieszana grupa z narzędziem nieterminującym może spowodować następne żądanie; opis narzędzia wymaga wywoływania `caller_ping` osobno.

**Miejsce:** `pi-extension/subagents/subagent-done.ts:313–317`, wynik narzędzia `caller_ping`.

**Problem:** narzędzie wywołuje `ctx.shutdown()`, ale nie zwraca `terminate: true`. Żądanie zamknięcia nie jest równoznaczne z zakończeniem bieżącej pętli. Po zgłoszeniu potrzeby pomocy może nastąpić następne żądanie do modelu i dalsza praca.

**Dowód:** `caller_ping` spowodował dwa żądania do kontrolowanego modelu, w tym jedno po żądaniu zamknięcia. Analogiczna próba z `subagent_done` spowodowała tylko jedno.

**Kierunek naprawy:** zwracać `terminate: true`, spójnie z `subagent_done`. Sprawdzić również semantykę wielu wywołań narzędzi w jednej odpowiedzi — samo ustawienie flagi nie musi przerwać całej mieszanej grupy narzędzi.

**Kryteria akceptacji:**
- Samodzielne wywołanie `caller_ping` nie powoduje następnego żądania do modelu.
- Rodzic otrzymuje dokładnie jedną prośbę o pomoc, z właściwą wiadomością.
- Zachowanie dla mieszanej grupy narzędzi jest jawnie określone i przetestowane.

## 4. Resume może używać nieaktualnych wymagań zadania

- [x] Walidować kontrakt względem efektywnego powiązania z planem, również odziedziczonego z profilu.
- [x] Dodać testy odrzucania nieaktualnego kontraktu przy wznowieniu.

Wdrożono wspólny preflight `resolveResumeContract` dla jawnego i odziedziczonego powiązania; ponowna kontrola po operacjach asynchronicznych przed wysyłką. Zarejestrowane narzędzie sprawdzone dla live i closed resume, bez zmiany planu ani wysyłki przy niezgodności. Testy plan-runtime/contracts/ownership-execute: 22/22 OK.

**Miejsce:** `pi-extension/subagents/index.ts:2118–2120, 2167–2169`, ścieżki live continuation i closed-session resume.

**Problem:** zgodność zapisanego kontraktu z aktualnym zadaniem jest sprawdzana tylko po jawnym podaniu `params.planTask`. Pominięcie tego opcjonalnego parametru zachowuje wcześniejsze powiązanie, ale omija kontrolę kontraktu. Po zmianie zakresu z A na B podagent dostaje nadal zakres A.

**Kierunek naprawy:** ustalić efektywne powiązanie z parametru i zapisanego profilu/stanu dziecka, a następnie zawsze sprawdzić kontrakt wobec aktualnej definicji. Nie przepisywać po cichu niezgodnego kontraktu ani nie zmieniać pierwotnej tożsamości zadania i próby.

**Kryteria akceptacji:**
- Jawny i pominięty `planTask` nie różnią się kontrolą nieaktualnych wymagań.
- Zmiana zakresu, kryteriów lub innych pól wyprowadzanych z zadania jest wykrywana przed wysłaniem wiadomości.
- Obie ścieżki wznowienia zachowują dotychczasowe ograniczenia uprawnień i powiązań.

## 5. Spóźnione potwierdzenie blokuje kolejne resume i close

- [x] Uzgadniać stan istniejącego żądania po spóźnionym potwierdzeniu.
- [x] Dodać test akceptacji i odrzucenia po timeoutcie, także po reloadzie.

Wdrożono `reconcileContinuation`: walidacja żądania, sesji, runId, tokenu i potwierdzenia (przy akceptacji także trwałego claim). Rozstrzygnięcie zapisuje się przed zwolnieniem blokady. Resume, close i odzyskiwanie używają wspólnego uzgadniania; recheck resume zwraca wynik pierwotnego żądania bez wysyłania nowej wiadomości. Testy late-continuation: 5/5 OK; istniejące live/recovery/close/store: 37/37 OK.

**Miejsce:** `pi-extension/subagents/live-continuation.ts:145–160`; blokada w `pi-extension/subagents/close-control.ts:122`.

**Problem:** po timeoutcie pozostaje `owner.continuationRequestId`. Nawet gdy dziecko później potwierdzi przyjęcie i wykona pracę, rodzic nie odczytuje ponownie potwierdzenia. Dalsze wznowienie i zamknięcie są odrzucane jako kolidujące z nierozstrzygniętym żądaniem.

**Kierunek naprawy:** umożliwić odczyt i uzgodnienie wyniku już istniejącego żądania, bez jego ponownego wysyłania. Zwalniać rezerwację po zweryfikowanej akceptacji lub jednoznacznym odrzuceniu. Przy rzeczywistej niepewności zachować blokadę. Uzgodnić również trwały zapis stanu.

**Kryteria akceptacji:**
- Spóźnione potwierdzenie nie pozostawia trwałej blokady.
- Żądanie jest wykonywane najwyżej raz; uzgadnianie nie powoduje ponownej wysyłki.
- Po zakończeniu pracy możliwe są dalsza kontynuacja i bezpieczne zamknięcie.
- Nieprawidłowe lub obce potwierdzenie nie zwalnia blokady.

## 6. Niespójne stany po Escape

- [x] Oddzielić żądanie przerwania od potwierdzonego przerwania tury.
- [x] Dodać test ręcznego Escape oraz Escape wysłanego do bezczynnego dziecka.

Wdrożono: etykieta rodzica jest obserwacją, nie potwierdzeniem Escape. Kontynuację dopuszcza aktualny token bezczynności dziecka powiązany z run/session, po sprawdzeniu procesu, panelu i custody. `test/live-continuation-native.test.ts` przechodzi przez natywne `AgentSession.abort()` i kontynuację tej samej sesji; testy jednostkowe odrzucają stare/obce tokeny i pracujące dziecko. Dostarczenie fizycznego klawisza Escape przez terminal nie jest tu zweryfikowane.

**Miejsce:** `pi-extension/subagents/live-continuation.ts:114–135`; `pi-extension/subagents/index.ts:1022`, `markInterruptRequested()`.

**Problem:** ręczny Escape w panelu dziecka może dać `interrupted-idle` po stronie dziecka, ale `waiting` po stronie rodzica. Wznowienie zostaje odrzucone. Odwrotny przypadek: przerwanie już bezczynnego dziecka ustawia rodzica jako `interrupted`, ale dziecko zachowuje `settled-idle`.

**Kierunek naprawy:** uzgadniać kwalifikację do kontynuacji z aktualnym, powiązanym z uruchomieniem potwierdzeniem stanu dziecka. Samo wysłanie Escape nie dowodzi przerwania tury. Nie osłabiać kontroli tożsamości, bezczynności i własności procesu.

**Kryteria akceptacji:**
- Dziecko przerwane ręcznie można wznowić bez zamykania procesu.
- Escape wysłany do już bezczynnego dziecka nie blokuje późniejszego wznowienia.
- Pracujące dziecko oraz nieaktualne potwierdzenie bezczynności nadal nie pozwalają na wysłanie kontynuacji.

## 7. Nowy wynik może zawierać podsumowanie poprzedniego zadania

- [x] Ograniczyć ekstrakcję podsumowania do bieżącej tury i aktywnej gałęzi.
- [x] Dodać test kończenia tury bez tekstu asystenta.

Wdrożono: granica nadzorowanego zadania to zbiór identyfikatorów wpisów sprzed `before_agent_start`; tekst wybierany jest wyłącznie z nowych wpisów aktywnej gałęzi. Brak tekstu ma jawny komunikat, aby legacy fallback rodzica nie odczytał poprzedniego zadania. `test/completion-turn.test.ts` obejmuje keepOpen, wznowienie i porzuconą gałąź; wynik strukturalny zachowuje niezależność.

**Miejsce:** `pi-extension/subagents/run-artifacts.ts:31`, `writeRunCompletion()`; pomocniczo `findLastAssistantMessage()` w `session.ts`.

**Problem:** `getNewEntries(session, 0)` obejmuje całą historię. Gdy bieżąca tura zawiera jedynie wywołanie `subagent_done`, wyszukiwanie cofa się do wcześniejszego zadania. Niezmienne zdarzenie może zawierać strukturalny wynik „zadanie B zablokowane” oraz tekstowe podsumowanie „zadanie A ukończone”.

**Kierunek naprawy:** zapamiętać granicę bieżącej tury i respektować aktywną gałąź. Jeśli bieżąca tura nie zawiera podsumowania tekstowego, zachować jego brak albo zastosować jawny, odpowiedni fallback. Nie podstawiać tekstu z poprzedniego zadania.

**Kryteria akceptacji:**
- Podsumowanie nowej tury nie pochodzi z poprzedniej tury ani innej gałęzi.
- Strukturalny wynik pozostaje zachowany niezależnie od obecności tekstu.
- Zachowanie jest poprawne po wznowieniu i dla kolejnych tur keepOpen.

## 8. Instrukcje roli i `systemPrompt` bywają pomijane

- [x] Zachować instrukcje roli przy bezpośrednim przekazaniu zadania w fork.
- [x] Ustalić i udokumentować semantykę `systemPrompt` obok treści nazwanego agenta.
- [x] Sprawdzić instrukcje faktycznie otrzymywane przez model.

Wdrożono: `systemPrompt` uzupełnia treść nazwanego agenta (body najpierw), nigdy jej nie zastępuje. Tryb append/replace zachowuje dotychczasową semantykę wobec promptu Pi; bez tego trybu rola trafia razem z zadaniem również w fork. `test/role-delivery.test.ts` sprawdza 21 przypadków przez rzeczywisty builder/CLI parser i natywny kontekst modelu Pi; zewnętrzne CLI mają testy poleceń i braku duplikacji, nie kontekstu ich providerów.

**Miejsce:** `pi-extension/subagents/index.ts:1211–1214`; `pi-extension/subagents/harness/drivers/pi.ts:138–140`.

**Problem:** bez `system-prompt: append/replace` rola trafia do `roleBlock`. Przy fork ścieżka bezpośrednia nie dołącza tego bloku. Dotyczy to także gołego wywołania z `systemPrompt`. Ponadto wyrażenie `agentDefs?.body ?? params.systemPrompt` całkowicie pomija parametr, gdy nazwany agent ma własną treść.

**Kierunek naprawy:** zagwarantować dostarczenie wybranej roli niezależnie od trybu sesji. Jawnie określić, czy parametr uzupełnia, czy zastępuje treść agenta; dostosować opis narzędzia i implementację. Nie raportować instrukcji jako przekazanych wyłącznie dlatego, że zapisano je w profilu.

**Kryteria akceptacji:**
- Rola dociera do modelu w `standalone`, `lineage-only` i `fork`.
- Testy obejmują brak pola `system-prompt`, `append`, `replace`, goły `systemPrompt` i parametr podany obok nazwanego agenta.
- Instrukcje nie są pomijane ani niepotrzebnie duplikowane.

## 9. Kontrakt omija walidację wymaganej wiadomości kontynuacji

- [x] Walidować oryginalną wiadomość przed dopisaniem metadanych.
- [x] Dodać testy braku wiadomości, pustego tekstu i samych białych znaków.

Wdrożono: live resume sprawdza surowe `params.message` przed `contractTask`; closed resume nadal dopuszcza brak wiadomości. Testy zarejestrowanego narzędzia w `test/plan-runtime.test.ts` i `test/ownership-execute.test.ts` obejmują warianty z kontraktem i bez, bez publikacji żądania przy odrzuceniu.

**Miejsce:** `pi-extension/subagents/index.ts:2120`, budowa `continuationParams`.

**Problem:** `contractTask()` dopisuje kontrakt przed sprawdzeniem, czy wiadomość kontynuacji jest niepusta. Dla dziecka z zapisanym kontraktem wywołanie `subagent_resume({sessionPath})` może rozpocząć kolejną turę zawierającą wyłącznie metadane, zamiast zostać odrzucone.

**Kierunek naprawy:** w ścieżce live continuation sprawdzać `params.message` przed wzbogaceniem o kontrakt. Zachować rozróżnienie od closed-session resume, dla którego wiadomość jest opcjonalna.

**Kryteria akceptacji:**
- Brak wiadomości, pusty tekst i same białe znaki są odrzucane przy live continuation, niezależnie od kontraktu.
- Odrzucenie nie publikuje żądania i nie rozpoczyna nowej tury.
- Poprawna wiadomość zachowuje swoją treść po dołączeniu metadanych.

## 10. Projekcja planu wyprzedza import oczekujących wyników

- [x] Wykonać ponowienie importów przed projekcją planu do kontekstu modelu.
- [x] Dodać test kolejności handlerów po odzyskaniu sprawności zapisu.

Wdrożono: ponowienie importów poprzedza publikację w `before_agent_start` i `turn_end`; zwykły context hook pozostaje bez mutacji. Awaryjne odtworzenie po kompakcji ma osobne ponowienie importów bezpośrednio przed fallbackiem. `test/plan-import-publication.test.ts` sprawdza produkcyjną kolejność oraz aktualną rewizję/status, bez ponownej dostawy ani dodatkowej tury. Niezależny przegląd zaakceptował tę implementację; pełne `npm test`: 626/626 bez pominięć.

**Miejsce:** `pi-extension/subagents/index.ts:1485, 1500–1502`; rejestracja `registerPlanContext()` przez `plan-tools.ts`.

**Problem:** handler generujący kontekst planu jest rejestrowany przed handlerem ponawiającym import wyników. Udany import aktualizuje plan już po stworzeniu projekcji. Model może otrzymać rewizję 3 i `in_progress`, podczas gdy ta sama obsługa kontekstu zapisała już rewizję 4 i `in_review`.

**Kierunek naprawy:** uporządkować fazy: najpierw uzgodnienie oczekujących importów, potem projekcja aktualnego stanu. Sam renderer/projektor powinien pozostać tylko do odczytu; zmiana kolejności nie może ponownie wysyłać wyników ani budzić modelu.

**Kryteria akceptacji:**
- Po udanym ponowieniu importu model otrzymuje aktualną rewizję i status.
- Projekcja nie powoduje dodatkowych zapisów, duplikacji wyników ani powiadomień.
- Nieudany import pozostaje widoczny jako problem, a nie jako pozornie zakończona aktualizacja.

## Weryfikacja dotychczasowego przeglądu

- 340 wybranych istniejących testów przeszło w zakończonych uruchomieniach głównego przeglądu. Nie sumowano ponownie testów wykonanych przez niezależnych recenzentów.
- `npm run lint` zakończył się powodzeniem.
- Pełne `npm test` przekroczyło limit 180 sekund; nie jest to potwierdzenie przejścia całego zestawu. Błąd testu recovery widoczny w tym przebiegu nie powtórzył się przy osobnym uruchomieniu.
- Problemy sprawdzano lokalnymi reprodukcjami, natywnym SDK, kontrolowanym modelem i atrapami transportu. Nie przeprowadzono pełnej weryfikacji e2e w rzeczywistych terminalach Pi/herdr.
- Reprodukcje przeglądu nie zostały dodane jako trwałe testy regresji w repozytorium. Ich dodanie jest częścią powyższych zadań.
- Istniejące zmiany użytkownika pozostały nienaruszone.

## Warunki zamknięcia listy

- [ ] Wszystkie punkty mają naprawę i odpowiedni test regresji.
- [ ] Pełny zestaw testów kończy się i ma wyjaśnione wszystkie błędy.
- [ ] Lint przechodzi.
- [ ] Przeprowadzono testy rzeczywistych sesji dla fork, skillów, ping, ręcznego Escape, keepOpen i wznowienia.
- [ ] Potwierdzono brak regresji w niezmienności wyników, deduplikacji, trwałym outboxie, kontroli gałęzi i własności procesu.
- [ ] Zaktualizowano dokumentację tam, gdzie doprecyzowano zachowanie publicznych parametrów.
