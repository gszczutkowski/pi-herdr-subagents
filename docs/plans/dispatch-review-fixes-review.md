# Niezależne review dispatch/recovery

## VERDICT: PASS

## FINDINGS

Brak potwierdzonych defektów wymagających poprawy w ocenionych zmianach. Nie stwierdzono konkretnych nowych regresji. Werdykt opiera się na samodzielnym przeglądzie kodu i wykonaniu testów, nie na raporcie workera.

### Trzy wymagane naprawy

1. **Ponowna blokada storage przed dispatch-intent — potwierdzona.** W pi-extension/subagents/index.ts callback launchSubagent/onDispatch ponownie wywołuje assertStorageAvailable() bezpośrednio przed zapisem intent. Między tym sprawdzeniem a intent i transportem nie ma await. Obejmuje to start oczekujący wcześniej na shell-ready. Test dwóch startów A/B potwierdza: błąd B blokuje A nawet po ustąpieniu błędu dysku; A pozostaje prepared, transport nie jest wywołany.
2. **Wspólny nadzór command/tool — potwierdzony.** pendingParentRecovery i recoverParentRuntime współdzielą promise dla tego samego SessionManager, kontekstu lifecycle, API i store. Świeże konteksty komendy/narzędzia mogą dołączyć do tej operacji. restoreParentRuntime weryfikuje custody po await; nieaktualny zwrócony nadzór zatrzymuje przed instalacją. Test opóźnionego challenge potwierdza jeden challenge, jeden timer nadzoru i jego zatrzymanie przy shutdown. Osobny test potwierdza, że późny błąd starej operacji trafia do wywołującego bez nadpisania stanu nowej gałęzi.
3. **Plan-only NO_DURABLE_RUN — potwierdzony.** readRecoveryView wylicza incydenty również bez manifestu; notifyRecoveryOnStartup uwzględnia je przy zerowej liczbie runów. Fingerprint acknowledgment korzysta z parent manifestu albo tożsamości zweryfikowanego aktywnego planu. Testy obu wariantów (pusty manifest / brak manifestu) potwierdzają ostrzeżenie, acknowledgment, wyciszenie po reload, zachowanie raportu i ponowne ostrzeżenie po nowym incydencie.

## CHECKS — wykonane niezależnie przez reviewera

Środowisko: Windows, Node v24.21.0.

- npm test — PASS: **833/833**, 0 pominiętych, 0 błędów.
- npm run typecheck — PASS.
- npm run lint — PASS.
- node --test --test-name-pattern='registered spawn/resume|share one supervisor|plan-only startup incident|late supervision failure|startup acknowledgement' test/dispatch-failure.test.ts test/dispatch-recovery.test.ts test/recovery-report.test.ts — PASS: **6/6**.
- git diff --check — PASS; jedynie ostrzeżenie Git o przyszłej konwersji LF do CRLF w dispatch-failure.test.ts.
- git status --short, git diff main, git rev-parse HEAD, git hash-object — sprawdzenie zakresu i wersji. Skróty ośmiu kluczowych plików były identyczne przed i po dodatkowym przebiegu celowanym.

## Wersja ocenionego kodu

Baza main i HEAD: f74d605cdf2027c4c0540b33ac4eb3430bb489ce. Oceniano lokalny katalog roboczy, włącznie z nieśledzonymi plikami implementacji/testów; nie sam commit.

Git blob IDs:

| Plik | Hash |
| --- | --- |
| pi-extension/subagents/index.ts | c9111c3f438fb130458a569c5d3748cf19dc3a53 |
| pi-extension/subagents/recovery-report.ts | 9d6603d8bda02efc7db194dd2dfd18245993f55f |
| pi-extension/subagents/dispatch-recovery.ts | a84ac51f96a2ae1801d04f3e6157217cb4b8aa51 |
| pi-extension/subagents/runtime-recovery.ts | cd883f8a8cbc3e1b6c8da9f9ba5bc70f744f2dae |
| pi-extension/subagents/runtime-store.ts | dce4de0a0c439af916d74bb5820944f60f59e234 |
| test/dispatch-failure.test.ts | cb1a2d588b60a3b017d1a41751f761851180147c |
| test/dispatch-recovery.test.ts | ab9a6b2f2dedc4948a9f371ff8d1890cc0860762 |
| test/recovery-report.test.ts | 1a368fe47450d96a625bb4a855d6939f0fbacd8e |

## COVERAGE i ograniczenia

Przejrzano bieżący diff względem main: dispatch/recovery, manifest i retry zapisu, import wyników do planu, recovery report/acknowledgment, lifecycle/navigation/shutdown, blokady resume, integracje delivery, historię/widget i guidance keep-open, zmiany testów, skrypt npm, instrukcje ról i dokumentację API. Sprawdzono także nowy nieśledzony moduł dispatch-recovery oraz nowe testy. Uwzględniono konflikty i walidację journal, zachowanie generacji, identyczne pozostałości po publikacji, run-bound proof i deny-tools.

Drzewo zawiera wcześniejsze, mieszane zmiany. Bez osobnego commitu/snapshotu poprawek nie można niezależnie przypisać autorstwa każdej zmienionej linii; werdykt dotyczy całej ocenionej wersji, a nie wyłącznie trzech ostatnich poprawek.

Nie uruchamiano osobnego npm run test:integration ani ręcznej sesji TUI/herdr z modelem (nie wymagano). Zmiany UI oceniono kodowo i przez istniejące testy, nie przez ręczny odbiór działającego terminala. Pełny npm test obejmował istniejące testy natywne/RPC i Windows; nie stanowi to deklaracji pełnego live E2E. Nie zmieniano kodu, testów ani zależności; jedyny zapis reviewera to ten raport. Bez commit/push.

Korelacja: planId=dae84a72-48a7-429a-8eb9-71456904b11d; taskId=6aac88ca-32f8-40af-a1a7-037c05092b23; attemptId=5a9b7ae0-0469-46b4-b7dd-f92d300fc337; runId=10344bf6-9b9d-443e-8cfb-f12a61982a9d. Końcowa akceptacja należy do koordynatora.
