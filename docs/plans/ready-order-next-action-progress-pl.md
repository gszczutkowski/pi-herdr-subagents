# Ready order — stan etapu implementacji

Specyfikacja: [ready-order-next-action-spec-pl.md](ready-order-next-action-spec-pl.md). Baza: `main` (`f74d605`) z istniejącymi lokalnymi zmianami kontroli własnych dzieci koordynatora i odzyskiwania dyspozycji. Tryb kolejki nadal nie jest włączony w Pi. Wynik etapu bramki pierwszej wysyłki: [raport integracji](ready-order-runtime-gate-report-pl.md).

## Zakres przygotowanego rdzenia

- `plan-queue.ts`: deterministyczny evaluator i decyzje kolejności na podstawie przekazanych faktów. Odczyt nie rezerwuje miejsca i nie wznawia wykonawców.
- `plan-store.ts`, `plan-persistence.ts`: wewnętrzne polecenia dla wersjonowanego formatu v2 — konfiguracja, pauza, obszar pracy, blokada, rezerwacja w jednej mutacji z próbą, rejestrowanie dyspozycji i rozliczenie. Odczyt formatu v1 nie daje uprawnień do uruchomienia kolejki.
- Weryfikacja warunków przed dyspozycją nie oznacza uprawnienia do wysłania polecenia. Po asynchronicznym przygotowaniu przyszła integracja potrzebuje jednokrotnego autoryzowanego pozwolenia z bieżącego wywołania i synchronicznego utrwalenia intencji w runtime przed wejściem do transportu. Odzyskany zapis `uncertain` nie jest pozwoleniem na wysyłkę.

## Granica wykonawcza

- Kontrola własnego dziecka istnieje w drzewie roboczym, ale [`subagent_close`](../../pi-extension/subagents/close-control.ts) potwierdza śmierć **oryginalnego PID i generacji procesu**, nie zakończenie potomków ani rozliczenie ich wysyłek. `remainingOwners=0` nie wyklucza niezweryfikowanych procesów. Historia pochodzenia i wyniki dostarczone do rodzica również nie stanowią takiego dowodu. [Raport tej funkcji](coordinator-own-child-capabilities-implementation.md) nie zawiera zaliczonej końcowej niezależnej oceny ani próby live.
- Zamknięte wznowienie nie może podmienić pierwotnego `PlanTaskBinding` na ID nowej próby. To zabezpieczenie pozostaje w mocy; nowa ścieżka wykonawcza musi jawnie rozróżniać świeże przydzielenie od kontynuacji istniejącej rezerwacji.
- `queue-dispatch-proof.ts` pozwala potwierdzić brak wysyłki na podstawie dopasowanego zapisu `prepared` i definitywnego zdarzenia przed wysyłką pod bieżącą władzą runtime. Brak rekordu, niepewny zapis, otwarta kontynuacja, wynik i brak nadzoru nie potwierdzają zwolnienia drzewa. Obserwacja `working` nie jest dowodem zamknięcia.
- `plan-runtime.ts` nie przekazuje rezerwacji zapisanej w nowym formacie do dotychczasowej ścieżki `subagent` / `subagent_resume`. Test wykonujący zarejestrowane narzędzia sprawdza, że w tym przypadku nie ma wywołania wysyłki ani utworzenia panelu. Ochrona nie zmienia importu wyników ani przejść dla istniejących planów v1.

## Weryfikacja końcowa rdzenia (R3)

- `npm test`: 866 zaliczonych, 0 błędów i pominięć; `npm run typecheck`, `npm run lint` i `git diff --check` zakończone pomyślnie (Git zgłosił tylko konwersję LF/CRLF w istniejącym pliku testowym).
- Niezależny przegląd R3: **PASS dla rdzenia**. Obejmuje m.in. odrzucenie starych dowodów po ponowieniu, limit napraw między wykonawcami, ponowienie po udowodnionym braku wysyłki w ramach tej samej decyzji oraz weryfikację obszarów w ograniczonych porcjach. Timeout sprawdzenia obszaru nie jest dowodem, że obszar zniknął albo że nie ma gotowych zadań.
- Scenariusz live Pi/herdr ze specyfikacji: **niezweryfikowany**; pełny tryb kolejki nie jest dostępny do uruchomienia.

## Etap integracji: pierwsza wysyłka (częściowy)

- `queue-launch-gate.ts` wiąże wewnętrzne, jednorazowe pozwolenie z dokładną próbą, identyfikatorem wykonania, sesją i bieżącą władzą rodzica. Ponownie sprawdza plan i przydział tuż przed trwałym przejściem `prepared → dispatch-intent`. Narzędzia Pi nie wystawiają tego pozwolenia; odzyskany zamiar nie uprawnia do wysyłki.
- `subagent` i zamknięte `subagent_resume` używają wspólnego zapisu zamiaru. Nadal odrzucają powiązanie z kolejką; resume odrzuca również dokładnie skorelowany zapis kolejki, gdy sidecar nie zawiera `planTask`. Niezwiązana sesja nadal korzysta ze starej ścieżki.
- Brak rozliczenia potomków oznacza brak zwolnienia rezerwacji na podstawie wyniku, śmierci samego koordynatora lub zniknięcia panelu. Bramka potomka i rozliczenie drzewa nie są wdrożone. Bez nich nie podłączono opt-in, nowych poleceń API ani UI.
- Weryfikacja tego etapu: 102 testy obszarowe i 866 pełnego `npm test`, bez błędów i pominięć; typecheck, lint i kontrola białych znaków przeszły. To nie jest zaliczenie pełnej macierzy T01–T12 ani próba live. Brak końcowego niezależnego przeglądu tego etapu.

## Warunki dalszej integracji

1. Związać delegowane wykonanie z niezmiennym `(planId, taskId, attemptId, runId)` i zweryfikowanym przydziałem. Egzekwować ograniczenie przydziału u bezpośrednich wykonawców również przed wznowieniem, bez dodawania władzy nad rodzeństwem lub odzyskanymi panelami. Pauza musi być widoczna w bramce potomka przed jego wysyłką, nie tylko w widoku rodzica. Nie używać niezwiązanych wywołań do wykonania zadania, któremu odmówiono przydziału; nie zmieniać semantyki niezwiązanych wywołań dla odrębnych prac.
2. Dodać korelację rozliczenia całego drzewa: bezpośredni właściciel zamyka możliwość dalszych wysyłek i zapisuje dowód rozliczenia dzieci; jego rodzic sprawdza identyfikatory, nienaruszoną władzę, brak nierozliczonych dyspozycji i potwierdzone zakończenie tego wykonawcy. Brak dowodu oznacza utrzymanie rezerwacji. Nie opierać tej decyzji na komunikacie `complete`, zniknięciu panelu, potwierdzeniu żądania abort ani braku obserwowanego PID.
3. Dopiero po integracji bramek podłączyć komendy opt-in oraz stronicowaną projekcję `nextActions` i `/plan-view next`. Dodać ścieżkę trwałych decyzji naprawczych bez ponownej wysyłki duplikatu, wraz z agregacją napraw dziecka u koordynatora. Sprawdzić przypadki T01–T12 z licznikami transportu oraz scenariusz live Pi/herdr dla tej samej wersji. Testy warstwy planu i testy z kontrolowaną wysyłką nie są scenariuszem live.
