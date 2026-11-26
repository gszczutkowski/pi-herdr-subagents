# Naprawy po review dispatch/recovery — raport workera

**STATUS: COMPLETE** — propozycja do niezależnej akceptacji koordynatora.

## Zmiany i zakres

- `pi-extension/subagents/index.ts`: zwykły `subagent` ponownie sprawdza blokadę zapisu tuż przed `dispatch-intent`. Odtwarzanie nadzoru współdzieli bieżącą operację dla tej samej instancji store, kontekstu lifecycle i API Pi. Świeże konteksty komendy/narzędzia dołączają po sprawdzeniu tej samej sesji; utrata custody nadal zatrzymuje nieaktualny nadzór.
- `pi-extension/subagents/recovery-report.ts` oraz `index.ts`: nierozstrzygnięte incydenty kwalifikują się do powiadomienia i potwierdzenia także przy zerowej liczbie runów. Bez manifestu potwierdzenie wiąże się z zapisanym, zweryfikowanym planem na aktywnej gałęzi. Zmiana dowodów przywraca ostrzeżenie; potwierdzenie go nie usuwa z raportu. Nie można potwierdzić widoku z niezweryfikowanym zapisem lub wstrzymanym custody.
- `test/dispatch-failure.test.ts`: deterministyczna bramka shell-ready; B blokuje zapis, A nie zapisuje `dispatch-intent`, żaden start nie wysyła polecenia.
- `test/dispatch-recovery.test.ts`: kontrolowana odpowiedź na probe; równoległa komenda i narzędzie korzystają z jednego nadzoru. Regresje `NO_DURABLE_RUN` sprawdzają powiadomienie, potwierdzenie, reload i ponowne ostrzeżenie na nowy incydent, z pustym manifestem i bez niego.

Zmiany są punktowe na istniejącym zmodyfikowanym drzewie. Nie cofano ani nie zatwierdzano zmian użytkownika.

## Weryfikacja — Windows, Node v24.21.0

- `npm run typecheck` — PASS.
- `npm run lint` — PASS.
- `unset PI_TEST_HC_TUI PI_TEST_HC_LIVE; node --version && npm test` — PASS, 833 zaliczone, 0 pominiętych, 0 błędów (limit 600 s).
- `node --test --test-name-pattern='registered spawn/resume|share one supervisor|plan-only startup incident|late supervision failure|startup acknowledgement' test/dispatch-failure.test.ts test/dispatch-recovery.test.ts test/recovery-report.test.ts` — PASS, 6/6. Pierwszy przebieg przed doprecyzowaniem licznika probe błędnie liczył również kontrole PID rodzica; test końcowy liczy wyłącznie PID dziecka.
- `git diff --check` — PASS; Git ostrzegł o konwersji LF→CRLF dla `test/dispatch-failure.test.ts`.
- Realne testy terminalowe/modelowe `npm run test:integration` — NOT RUN; poza zakresem. Widok powiadomienia sprawdzony w fixture rozszerzenia, nie w uruchomionym TUI.
