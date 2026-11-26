# Ready order — raport etapu bramki wysyłki

**CZĘŚCIOWY; tryb kolejki pozostaje wyłączony.** Podstawa: `f74d605cdf2027c4c0540b33ac4eb3430bb489ce` i zastane lokalne zmiany. Nie wykonano commitu ani push.

## Zmiany

- `pi-extension/subagents/queue-launch-gate.ts`: wewnętrzne pozwolenie na pierwszą wysyłkę, wydawane przez synchroniczne porównanie i zapis planu. Po przygotowaniu ponownie sprawdza właściciela gałęzi, plan, bieżącą próbę, przydział i dokładny rekord runtime. Pozwolenie jest zużywane również przy odmowie; wznowienie procesu nie odtwarza go z dysku.
- `pi-extension/subagents/runtime-store.ts`, `index.ts`, `plan-runtime.ts`: rzeczywiste ścieżki świeżego startu i zamkniętego resume wymagają trwałego przejścia z pierwotnego `prepared` do `dispatch-intent` przed wysłaniem. Legacy odrzuca v2 przed przydzieleniem panelu. Resume nie omija blokady, gdy dokładny rekord kolejki jest w wybranym planie i manifeście, ale brakuje wiązania w sidecarze. Niezwiązane prace zachowują dotychczasową ścieżkę.
- `test/dispatch-failure.test.ts`: kontrolowany `runScriptInPane` i mock właściwego wywołania transportu. Jedno wywołanie dla ważnego pozwolenia i zero dodatkowych po duplikacie lub powtórzeniu; zero po pauzie, blokadzie zadania, utracie władzy, zmianie gałęzi, niezgodnym wiązaniu lub błędzie zapisu zamiaru. Zarejestrowane narzędzia: zero wysyłek i paneli dla powiązanych prób v2, także przy pozbawionym wiązania sidecarze; jeden send dla niezależnego resume i brak mutacji planu.

## Dowody pierwotnego etapu (Windows, Node v24.21.0)

```sh
env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_SUBAGENT_COMPLETION_MODE -u PI_DENY_TOOLS node --test --test-reporter=spec test/dispatch-failure.test.ts test/queue-dispatch-proof.test.ts test/plan-queue.test.ts test/plan-runtime.test.ts test/runtime-store.test.ts test/runtime-manifest-windows.test.ts test/ownership-execute.test.ts test/live-continuation.test.ts
env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_SUBAGENT_COMPLETION_MODE -u PI_DENY_TOOLS npm test
npm run typecheck
npm run lint
git diff --check
```

Wynik końcowy: **102/102 obszarowe, 866/866 pełne**, bez pominięć; typecheck, lint i diff check zaliczone (ostrzeżenie LF/CRLF). Przed zmianami typecheck, lint i diff check zaliczone; pełny baseline przekroczył 240 s, wcześniej raportował m.in. błąd startu procesu potomnego `3221225794` w `runtime-recovery.test.ts`. Nie ma zaliczonego baseline tej próby. Brak niezależnego końcowego review, pełnego wykonania T01–T12 i scenariusza live; kontrole transportu powyżej nie są scenariuszem live.

## Pierwotny odbiór przez rodzica (historyczny)

Rodzic ponownie zaliczył `npm run typecheck`, `npm run lint` i `git diff --check`. Wynik 866/866 pochodzi z wykonania koordynatora, nie z ponownego pełnego uruchomienia przez rodzica. Niezależny reviewer nie zwrócił oceny: dostawca odmówił przetworzenia ze wskazaniem możliwego ryzyka cyberbezpieczeństwa. Nie ponowiono tego samego przeglądu u innego modelu. Koordynator zakończył bez poprawnego raportu strukturalnego; zapis sesji i niniejszy raport zachowują częściowy wynik. Zadanie nie zostało zaakceptowane; pełna funkcja pozostaje niewdrożona.

## Poprawki po przeglądzie bramki

- `subagent_resume` nie traktuje sesji jako niezwiązanej, jeśli dokładny rekord w manifeście zawiera wiązanie, którego brakuje w zapisanym profilu lub które się z nim nie zgadza. Odmowa działa również na historycznym widoku i bez wybranego planu; nie tworzy panelu ani nie zmienia manifestu. Niezwiązane wznowienie i pierwsze wiązanie z planem v1 nadal działają.
- Wewnętrzne pozwolenie przed `dispatch-intent` sprawdza `cwd` z przygotowanego profilu Pi. Brak katalogu w profilu lub rozbieżność z rezerwacją zatrzymują wysyłkę.
- Na Windows / Node v24.21.0 testy z nowymi przypadkami w `test/dispatch-failure.test.ts` przeszły w pełnym `npm test`: **866/866**, bez pominięć. Typecheck, lint i kontrola białych znaków zaliczone. Bez próby live; kolejka pozostaje wyłączona.

## Stan po naprawie regresji resume v1

Późniejszy przegląd bramki wykrył regresję legacy: po pierwszym wiązaniu zamkniętego resume zapis planu mógł się udać, a zapis `planTask` do sidecara zakończyć się `EPERM`. Zachowany związany rekord błędu przed wysyłką blokował wtedy jawne retry z nową próbą.

**Naprawione i zaakceptowane w zakresie tej regresji:**

- `pi-extension/subagents/index.ts`: jawne retry tego samego zadania v1 może ominąć stare wiązanie wyłącznie przy dokładnym, kanonicznym dowodzie niewysłania poprzedniej próby. Samo `prepared` nie wystarcza.
- Kolejne wznowienia po udanym retry wymagają zgodnego zapisanego wiązania bieżącej próby v1 oraz trwałego rekordu nadzorowanego uruchomienia tej samej sesji w tej próbie. Dowód niewysłania poprzednika nadal jest wymagany; nie przepisuje się historii ani dowodów błędu.
- `test/dispatch-failure.test.ts`: rzeczywista jednorazowa odmowa zmiany nazwy sidecara, jawne retry, dalsza kontynuacja live i zamknięte resume po odtworzeniu runtime. Przypadki negatywne obejmują sam sidecar, samo `prepared` i nowy niepewny zamiar mimo poprawnego następcy. Blokady v2 pozostają zachowane.
- Pierwsza wersja poprawki nie obsługiwała dalszych wznowień; niezależny review odrzucił ją. Po jednej rundzie napraw końcowy niezależny review zwrócił **PASS**, bez potwierdzonych usterek w tym zakresie.

Rodzic na końcowej wersji zaliczył **104/104 testy obszarowe** oraz ponownie pełne **866/866 (`npm test`)**, bez pominięć i błędów. Niezależny reviewer zaliczył **114/114** w swoim zestawie obszarowym. Zestawy różnią się zakresem; ich liczników nie należy sumować. Typecheck, lint i `git diff --check` zaliczone (ostrzeżenie LF/CRLF). Transport i procesy w scenariuszach regresyjnych są kontrolowane przez testy; nie wykonano próby live Pi/herdr.

To zastępuje historyczny brak końcowego review i ponownego pełnego uruchomienia przez rodzica **dla naprawy regresji**. Nie oznacza akceptacji całej funkcji ready order ani całości zastanych zmian. Nie wykonano commitu ani push; kolejka pozostaje wyłączona.

## Wewnętrzny adapter runtime — część pierwszego blokera

`pi-extension/subagents/queue-launch-gate.ts` tworzy teraz adapter z `queue-runtime-adapter.ts` dla konkretnego zapisu runtime. Adapter sprawdza bieżącą sesję, gałąź i zapisywalny plan v2, a przy ocenie wysyłki porównuje rezerwację, manifest i dziennik. Nie wydaje dowodu rozliczenia drzewa. Żadne zarejestrowane narzędzie nie wystawia pozwolenia.

Pierwsza wersja przeszła u rodzica 127/127 testów obszarowych i 867/867 pełnych, ale została odrzucona: niezależny przegląd wykazał, że sprzeczne wpisy dla innego `runId` mogą ukryć konkurencyjne wiązanie tej samej próby. W takiej sytuacji nie wolno ani zwolnić rezerwacji, ani zapisać zamiaru wysyłki. Po pierwszej poprawce adapter odmawia działania przy każdym konflikcie dziennika. Testy regresyjne potwierdzają odmowę w obu ścieżkach bez zmiany zapisów trwałych. Rodzic zaliczył 129/129 testów obszarowych (`--test-concurrency=2`), 869/869 pełnych oraz typecheck, lint i diff check. U wykonawcy pojedynczy test worktree nie przeszedł przy domyślnej współbieżności; przeszedł w powtórzeniach.

Drugi przegląd potwierdził naprawę konfliktu, ale odtworzył inny błąd: po przywróceniu starszego zapisu planu rezerwacja bez `runId` mogła zostać zwolniona jako niewysłana, mimo że manifest nadal zawierał nadzorowany run tej próby. W drugiej rundzie adapter sprawdza także odwrotną zależność: każdy zachowany rekord manifestu lub dziennika dotyczący tego planu musi pasować do przydziału w planie. Zwykłą rezerwację bez wysyłki nadal można zwolnić. Testy obejmują odtworzenie starszego planu z zachowanym samym manifestem lub samym dziennikiem. Wykonawca zaliczył 148/148 testów obszarowych; rodzic zaliczył pełne 873/873 bez pominięć, typecheck, lint i diff check. Nie wykonano testu live.

Trzeci przegląd potwierdził naprawę odtwarzania planu, ale wykazał możliwość zapisania zamiaru dla identyfikatora istniejącego wyłącznie w dzienniku, bez wiązania z planem. Nie dochodziło do wysyłki, lecz miejsce mogło pozostać zajęte. W ostatniej rundzie rozdzielono dwa sprawdzenia: przed zapisem w planie `runId` musi być wolny w manifeście i scalonych dowodach wysyłki; przed transportem musi istnieć dokładnie pasujący przygotowany run. Testy obejmują wpis w pliku, w pamięci, w zachowanych dowodach i w manifeście. W każdym przypadku odmowa nie zmienia stanu trwałego, a inny wolny identyfikator działa. Na tej wersji wykonawca zaliczył 143/143 testy obszarowe, rodzic pełne 877/877 bez pominięć, typecheck, lint i diff check.

**Odbiór adaptera wstrzymany.** Końcowy niezależny przegląd po trzeciej rundzie nie zwrócił oceny: dostawca przerwał go ze wskazaniem możliwego ryzyka cyberbezpieczeństwa. Nie jest to ani potwierdzenie usterki, ani akceptacja. Nie ponawiano przeglądu u innego modelu. Do odbioru tego etapu potrzebny jest niezależny przegląd tej samej wersji (np. ręczny). Identyfikatory blobów Git: `queue-runtime-adapter.ts` — `bd13d73f70ff00e5e2bb2c389ae283da1044aa36`, `queue-launch-gate.ts` — `e804d70e772e4fbf422c320e42d6729e0c6e9d19`, `test/queue-dispatch-proof.test.ts` — `266df018f219c042c3549264f6ba0bc724d05456`, `test/dispatch-failure.test.ts` — `f9ca1589e29dddd4932ff40010ebe2c44416f6d6`. Kolejka pozostaje wyłączona.

## Pozostało do zrobienia — w kolejności dostawy

Poniższe blokery funkcji ready order pozostają otwarte; naprawa resume v1 ich nie usuwa.

1. Przed wystawieniem pozwolenia przez rzeczywiste narzędzie potrzebna jest weryfikowalna tożsamość i alokacja przekazana dziecku, odczyt bieżącej pauzy i przydziału w bramce potomka oraz kontrola CWD/trybu także przed aktywnym resume. Wewnętrzna bramka korzysta już z adaptera runtime. Przy podłączeniu narzędzia nadal trzeba przekazać mu bieżącą instancję, stan błędów zapisu i nadzór z zaufanego runtime; sam adapter nie zastępuje bramek potomka ani resume.
2. Brak trwałego, nieodwracalnego zamknięcia wysyłek przez właściciela i skorelowanego rozliczenia jego bezpośrednich dzieci. Potwierdzona śmierć oryginalnego PID/generacji, wynik, historia, brak panelu i `remainingOwners=0` nie dowodzą rozliczenia drzewa. Bez dowodu nie zwalniać slotu i nie obchodzić pochodzenia przez zamknięte resume z nową próbą.
3. Dopiero po spełnieniu powyższych warunków podłączyć rzeczywistą ścieżkę kolejki i komendy opt-in, projekcję `nextActions` i `/plan-view next`, agregację napraw i kontrolę ich duplikatów oraz publiczną dokumentację. Nie ma jeszcze uruchamialnego UI tej funkcji do weryfikacji.
4. Wykonać pełną macierz T01–T12 z licznikami transportu oraz próbę live Pi/herdr na podłączonej funkcji. Dotychczasowe testy z kontrolowanym transportem ani pełne `npm test` nie zastępują tych dowodów.
5. Po domknięciu implementacji przeprowadzić niezależny końcowy review całej funkcji, ponowić odpowiednie testy na tej samej wersji kodu i uzyskać odbiór rodzica przed włączeniem kolejki. Obecny PASS dotyczy wyłącznie naprawy regresji resume v1.
