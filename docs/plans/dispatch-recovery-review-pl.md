# Raport do naprawy: odzyskiwanie dispatchu w rozszerzeniu Pi

**Werdykt:** poprawki przed scaleniem. **Baza:** lokalny `main`, commit `f74d605`. Review dotyczy katalogu roboczego, nie zakresu commitów — obejmuje także nieśledzone pliki, zwłaszcza `pi-extension/subagents/dispatch-recovery.ts` i `test/dispatch-recovery.test.ts`. Przy przekazaniu do innego checkoutu trzeba dołączyć te zmiany; sam `main` nie zawiera ocenianej implementacji.

Poniższe ustalenia pochodzą z analizy kodu. Opisane testy regresji są kryteriami odbioru proponowanych poprawek, nie deklaracją, że zostały już wykonane.

## R1 · P1 — błąd odzyskiwania znika przy wywołaniu z narzędzia lub komendy

**Miejsce:** `pi-extension/subagents/index.ts:716` (`catch` w `recoverParentRuntime`) oraz `:1863–1883` (wspólna obsługa `subagents_reconcile` i `/subagents-reconcile`).

Pi tworzy osobne obiekty `ExtensionContext` dla zdarzenia startowego, komendy i narzędzia. Mogą reprezentować tę samą sesję i gałąź. Obsługa reconciliation sprawdza `sessionManager`, ale `catch` w `recoverParentRuntime` porównuje referencje do całego `ctx`. Jeśli odtwarzanie nadzoru nad niezarejestrowanym runem rzuci wyjątek, `runtime.latestCtx !== ctx` może wyciszyć ten wyjątek. Bez wcześniejszej blokady zapisu wywołujący może następnie wznowić dostarczanie wiadomości, mimo że nadzór nie został odtworzony.

**Kryterium odbioru:** wywołać start i reconciliation z różnymi obiektami `ctx`, współdzielącymi `sessionManager`; wymusić błąd odtwarzania nadzoru. Oczekiwane: `still-blocked`, widoczna przyczyna i brak `flushDeliveries` w tej ścieżce. Osobno sprawdzić zmianę gałęzi podczas `await`: błąd starej operacji nie może zmienić stanu nowej sesji. Propagować niepowodzenie do wywołującego niezależnie od tego, czy nadal wolno zapisać je w stanie współdzielonym; nie usuwać kontroli własności sesji.

## R2 · P1 — niepoprawny rekord JSON nie zatrzymuje rotacji generacji

**Miejsce:** `pi-extension/subagents/dispatch-recovery.ts:160–175` (`readDispatchEvidence`), `pi-extension/subagents/index.ts:654–664` (decyzja o rotacji przy starcie).

Przy odczycie pliku `<runId>.json` błąd trafia do `conflicts`, ale `storeError` pochodzi z `operationCode(error)`. `SyntaxError` z `JSON.parse` i zwykły błąd walidacji nie mają `code`. Po restarcie, bez kopii w pamięci lub manifeście, plik nie trafia do `records`; przebieg naprawy może dopuścić zmianę generacji. Po przywróceniu poprawnego pliku oryginalny dowód zostaje odrzucony jako `WRITER_GENERATION_CONFLICT`. Dodatkowo `String(error)` z parsera może zawierać fragment danych wejściowych, który potem pojawi się w diagnostyce widocznej dla modelu.

**Kryterium odbioru:** zapisać prawidłowy dowód bieżącej generacji, zachować jego kopię, a przed restartem uszkodzić JSON i wyczyścić stan w pamięci. Start ma zgłosić blokadę bez zmiany generacji. Po przywróceniu kopii reconciliation ma opublikować zdarzenie dokładnie raz. Powtórzyć dla poprawnego składniowo JSON z niepoprawnym schematem. Diagnostyka powinna wskazywać run i rodzaj błędu bez cytowania zawartości pliku; do testu użyć niesekretnego znacznika.

## R3 · P2 — `deny-tools` nie wyłącza `subagents_reconcile`

**Miejsce:** `pi-extension/subagents/index.ts:1906–1915` (bezwarunkowa rejestracja) i `:2068–2079` (`PI_DENY_TOOLS`, `shouldRegister`).

Dziecko z `deny-tools: subagents_reconcile` i bez osobnej listy dozwolonych narzędzi nadal dostaje narzędzie zmieniające metadane. Kontrola sesji i gałęzi wewnątrz `execute` chroni cudzy stan, ale nie egzekwuje ograniczenia narzuconego tej roli dla jej własnej sesji.

**Kryterium odbioru:** w trybie dziecka Pi (`PI_SUBAGENT_ID`) z `PI_DENY_TOOLS=subagents_reconcile` narzędzia nie ma wśród zarejestrowanych nazw. Bez tego zakazu pozostaje dostępne, również dla zagnieżdżonego koordynatora jego własnych dzieci. Użyć tej samej ścieżki filtrowania co dla pozostałych narzędzi sterujących; sprawdzić rejestrację, a nie tylko odmowę podczas wykonania.

## R4 · P2 — plik pozostały po poprawnym zapisie przesłania kanoniczny outbox

**Miejsce:** `pi-extension/subagents/dispatch-recovery.ts:260–263` (sprzątanie po publikacji), `:294–312` (`dispatchIncidents`); konsument: `assertResumeDispatchKnown` w `pi-extension/subagents/index.ts`.

Po zatwierdzeniu zdarzenia usunięcie pliku dziennika jest opcjonalne — np. przy `EPERM` plik zostaje na dysku. Odczyt raportu klasyfikuje taki rekord jako `still-blocked`, zanim zbada outbox, a następnie pomija run obecny już w wynikach. Uszkodzeniu nie ulegają dane, lecz decyzja na ich podstawie: poprawnie naprawiony run może pozostać zablokowany dla `subagent_resume` tylko dlatego, że nie udało się posprzątać pliku.

**Kryterium odbioru:** wymusić błąd wyłącznie przy usuwaniu pliku po udanej publikacji. Dla przypadku `before-send` raport powinien zwrócić `resolved`; kolejne odczyty i reconciliation nie mogą dodawać zdarzeń ani wymagać usunięcia identycznego pliku. Dla `send-possible` identyczny duplikat nie może ani maskować kanonicznego statusu, ani być traktowany jako dowód wykonania. Osobny test negatywny: rozbieżny rekord nadal blokuje run. Nie wystarczy dać pierwszeństwa dowolnemu wpisowi o tym samym ID — porównać powiązanie z runem i treść dowodu.

## Weryfikacja przekazania

Na ocenianej wersji przeszły `npm run typecheck`, `npm run lint` i `npm test` (822/822). Nie uruchamiano oddzielnego `npm run test:integration` ani ręcznej sesji TUI w herdr. Zielony wynik jest punktem odniesienia, nie pokryciem czterech scenariuszy powyżej. Po poprawkach uruchomić nowe testy regresji i ponownie te trzy polecenia na tej samej wersji kodu. Dla R1 szczególnie wartościowa jest próba z rzeczywistą komendą i narzędziem Pi, bo atrapa ze wspólnym obiektem `ctx` ukrywa ten defekt.
