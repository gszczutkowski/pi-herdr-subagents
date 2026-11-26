# Ready order — bramki dziecka i aktywnego wznowienia

**Aktualizacja po R3: naprawiono opisaną niżej usterkę aktywnego resume. Punkt 1 jako całość nadal nie jest domknięty.**

### Poprawka po R3 — aktywne resume

- Rodzic zapisuje zamiar kontynuacji, a następnie sprawdza obraz profilu i sesji bezpośrednio przed zmianą nazwy pliku tymczasowego na `*.request.json`. Jeśli w tym czasie do sesji dopisano kartę, żądanie nie staje się widoczne dla watchera. Rodzic rozlicza dokładnie ten `requestId`; jeśli rozliczenie się nie uda, zachowuje rezerwację i blokuje ponowienie.
- Watcher i prywatna komenda sprawdzają fizyczne wpisy własnej sesji, nie tylko listę załadowaną przez Pi. Po zapisie roszczenia i stanu `busy`, tuż przed `sendUserMessage`, ponownie sprawdzają, czy obrazy plików są nadal aktualne. Nie jest to atomowa blokada między procesami.
- Trzy nowe testy w `test/ownership-execute.test.ts` i `test/live-continuation.test.ts` sprawdzają niezależnie: brak opublikowanego żądania i rozliczenie zamiaru po dopisaniu karty; zachowanie rezerwacji przy błędzie rozliczenia; zero wywołań `sendUserMessage` przez rzeczywisty watcher z nieaktualną listą wpisów w pamięci.
- Weryfikacja bez podagentów, Windows / Node v24.21.0: `npm test` **899/899** (bez pominięć); `npm run typecheck`, `npm run lint` i `git diff --check` zaliczone. Bez próby live Pi/herdr, commitu ani push. Dodatnia autoryzacja między procesami i rozliczenie drzewa pozostają poza zakresem; publiczne v2 nadal jest wyłączone.

## Co pozostało do wykonania

1. **Domknąć bramki potomka i aktywnego wznowienia (punkt 1).** Dodać zaufaną autoryzację między procesami, powiązaną z dokładną próbą, wykonaniem i przydziałem. Utrzymać ważność decyzji do granicy wysyłki: zmiana gałęzi, pauzy, stanu błędów lub przydziału ma ją unieważniać. Dopiero wtedy dopuścić wysyłkę potomka i aktywne wznowienie kolejki; odbiorca musi sprawdzić rzeczywisty katalog roboczy (CWD) i tryb względem przydziału. Brak aktualnego dowodu nadal oznacza odmowę.
2. **Rozliczać całe drzewo wykonania (punkt 2).** Każdy właściciel musi zamknąć możliwość dalszej wysyłki i utrwalić dowód rozliczenia dzieci. Rodzic zwalnia rezerwację dopiero po potwierdzeniu zakończenia wykonawcy i braku nierozliczonych dyspozycji w drzewie. Sam wynik, zniknięcie panelu ani zakończenie procesu koordynatora nie wystarczają.
3. **Dokończyć integrację v2 po spełnieniu tych warunków.** Domknąć odbiór adaptera i bramki pierwszej wysyłki, a dopiero po integracji bramek podłączyć publiczny opt-in, widoki `nextActions` i `/plan-view next` oraz trwałe decyzje naprawcze bez ponownej wysyłki duplikatów.
4. **Zweryfikować tę samą wersję end-to-end.** Wykonać pełną macierz T01–T12 z licznikami transportu i scenariusz live Pi/herdr. Wynik 899/899 potwierdza bieżącą poprawkę i istniejącą suitę, nie pełny przepływ kolejki v2.

Zob. [warunki dalszej integracji](ready-order-next-action-progress-pl.md#warunki-dalszej-integracji) i [specyfikację](ready-order-next-action-spec-pl.md).

## Stan historyczny przy zamknięciu R3

**CZĘŚCIOWY — NIEODEBRANY po R3; dalsze naprawy w tamtej próbie zatrzymane zgodnie z limitem trzech rund.** Podstawa: `f74d605cdf2027c4c0540b33ac4eb3430bb489ce` z zastanymi lokalnymi zmianami. Publiczny opt-in i ścieżki wykonawcze v2 pozostają wyłączone; bez commitu ani push.

## Co działa w tej wersji

- `pi-extension/subagents/queue-child-allocation.ts`, `launch-profile.ts`, `harness/drivers/pi.ts`, `assignment.ts`: wewnętrzny, wersjonowany przydział wiąże tożsamość planu, próbę, pierwotny `runId` i kanoniczny obszar oraz tryb. Profil może go dostać tylko przy przygotowaniu pierwotnej intencji; Pi przekazuje go w artefakcie zadania i utrwala przy zgodnej sesji dziecka. Niezależny znacznik przy sesji powstaje przed profilem. Kopia karty w forku nie daje temu forkowi tożsamości dziecka. Zapis przydziału nie jest pozwoleniem na wysyłkę. Pomocnik przygotowania pozostaje wewnętrzny; żadne narzędzie nie wywołuje go do pierwszej wysyłki v2.
- `index.ts`, `live-continuation.ts`: oznaczone dziecko nie uruchamia potomka ani wznowienia bez aktualnej, zaufanej władzy. Blokada dotyczy także odtworzenia bez zmiennej środowiskowej, zmiany klasyfikacji po przygotowaniu panelu i odebrania żądania przez watcher lub prywatną komendę. Nierozpoznany format przydziału nie daje uprawnień. Znacznik, profil, karta i manifest są wskazówkami klasyfikacji, nie dowodem bieżącej władzy.
- Naprawa po pierwszym przeglądzie: zapisany profil wystarcza do odmowy potomkowi i odbiorcy kontynuacji nawet bez znacznika, karty i zmiennej środowiskowej. Resume sprawdza fizyczne wpisy autoryzowanej sesji docelowej przed przygotowaniem i tuż przed wysyłką; karta kopiowana z innego pliku nie ogranicza forka. Wadliwe `lineage` nie powoduje wyjątku podczas sprawdzania karty.
- Druga runda napraw usuwa limity 4/64 MiB w inspekcji proweniencji. Zgodnie z jawną zgodą użytkownika **wyłącznie ta inspekcja** może przeczytać cały profil i wszystkie fizyczne wpisy wybranej sesji. Nie zmieniono limitów pozostałych magazynów ani dotychczasowego odczytu wpisów zamkniętego resume po tej bramce. Odczyt blokami 64 KiB, sekwencyjny, bez porzucania wpisów przekraczających blok; brak dowodu wymaga dojścia do końca pliku. Czas i I/O są liniowe od rozmiaru sprawdzanych plików na przebieg, bez dodatkowego zegarowego limitu. Pamięć skanu obejmuje blok, fragmenty dekodowanego pojedynczego wpisu (lub całego profilu), scalony tekst i zdekodowany obiekt — `O(największy wpis lub profil)`, granica ciągu to `Buffer.constants.MAX_STRING_LENGTH` z Node, a pozycje pliku muszą być bezpiecznymi liczbami JS. Nie jest to limit pamięci całej ścieżki legacy. Błędy, brak pełnego odczytu lub zmiana obrazu podczas skanu oznaczają odmowę bez cytowania treści.
- Faktyczne `readPiLaunchProfile` korzysta z tego samego czytnika. Przed i po odczycie porównuje kanoniczną ścieżkę, zwykły plik i jego metadane z otwartym deskryptorem (także na Windows bez `O_NOFOLLOW`). Resume przechowuje pierwotną tożsamość pliku sesji przez asynchroniczne przygotowanie i ponawia weryfikację przed wysyłką. Nie jest to atomowa blokada przestrzeni nazw: nie gwarantujemy wykrycia zmian między kontrolami, jeśli ich ślad znika i obie obserwacje oraz otwarty deskryptor są nadal zgodne.
- Trzecia runda: skan przypina nazwę i faktyczny deskryptor do pierwotnej tożsamości wybranej sesji; chwilowa podmiana tylko na czas skanu nie może dostarczyć wyniku ujemnego. Odczyt profilu odbywa się przed skanem kart, po którym ponownie porównuje się pełne metadane obrazu, nie tylko identyfikator pliku. Metadane są sprawdzane także przy ostatniej bramce zamkniętego resume po zapisie zamiaru. Legalne dopisanie między odrębnymi skanami nie jest błędem: nowy skan widzi aktualną zawartość tego samego pliku.
- Aktywne resume w rodzicu sprawdza aktualny runtime, prawa sesji i gałęzi, zapis błędów, dokładne powiązanie profilu i manifestu, aktualną pauzę/przydział, zależności oraz zapisane CWD profilu i nagłówka dziecka. Tryb nie może wyjść poza przydział ani użyć trybu użytkownika dla `write`. Po sprawdzeniach nadal następuje odmowa: nie powstaje żądanie kontynuacji. Zamknięte resume nie zmienia przydziału ani nie spada do ścieżki legacy. To kontrakt pracy, nie sandbox ani obserwacja CWD żywego procesu.

## Granica i dowody

Dziecko jest odrębnym procesem Pi. Odczyt planu lub manifestu nie potwierdza bieżącej gałęzi rodzica ani zatrzasków błędów w pamięci; nawet odpowiedź na pojedyncze wyzwanie może się zdezaktualizować między odpowiedzią a wysyłką potomka. Nie dodano takiego pozwolenia ani nowego transportu. Pozostały skorelowane potwierdzenie i ochrona przed zmianą władzy/pauzy/przydziału aż do granicy wysyłki, sprawdzenie rzeczywistego CWD/trybu u odbiorcy dopuszczonego resume, a osobno rozliczenie drzewa (punkt 2). Brak lub sprzeczność dowodu w oznaczonym przebiegu oznacza odmowę; nie ma gwarancji po usunięciu wszystkich niezależnych znaczników/proweniencji z lokalnego magazynu lub dla ręcznego uruchomienia poza kontrolowanymi ścieżkami.

Testy potwierdziły zero wysyłek terminalowych dla potomka i aktywnego lub zamkniętego resume kolejki, zero zaakceptowanych wywołań `sendUserMessage` w dziecku także po odtworzeniu i duplikacie, brak mutacji manifestu podczas odmowy resume oraz dokładnie jedną wysyłkę dla niezależnego przebiegu legacy. Test modelu przydziału potwierdza poprawny odczyt i jego walidację, a nie publiczną wysyłkę v2. W drugiej rundzie transport kontrolowany: jeden send dla prawidłowej sesji ponad 64 MiB z wpisami i profilem ponad 4 MiB; zero dla karty kolejki na końcu dużego pliku z kluczem między blokami, skróconego lub zmienionego odczytu, podmiany pliku podczas przygotowania i podmiany nadrzędnego junction na Windows (także przywróconego natychmiast po otwarciu). Dwa testy transportowe z trzeciej rundy potwierdziły zero wysyłek przy chwilowej podmianie pliku podczas skanu oraz dopisaniu karty do tego samego pliku podczas końcowego odczytu profilu. Końcowy niezależny przegląd R3 zwrócił **CHANGES_REQUIRED**: potwierdził naprawy zamkniętego resume, ale odtworzył dalszą usterkę aktywnego resume opisaną poniżej. Koordynator uruchomił pełne `npm test`: **896/896**, bez pominięć i błędów. Nie wykonano próby live Pi/herdr ani pełnej macierzy T01–T12. Zielona istniejąca pełna suita nie obejmuje niezaliczonej dodatkowej próby reviewera.

Windows / Node v24.21.0, **164/164**, bez pominięć:

```sh
set -o pipefail
env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_SUBAGENT_COMPLETION_MODE -u PI_DENY_TOOLS -u PI_SUBAGENT_QUEUE_CHILD node --test --test-reporter=spec --test-concurrency=2 test/launch-profile.test.ts test/live-continuation.test.ts test/ownership-execute.test.ts test/assignment.test.ts test/harness-drivers.test.ts test/resume-safety.test.ts test/automated-harness-boundary.test.ts test/automated-plan-boundary.test.ts test/architecture-authority.test.ts test/runtime-execute.test.ts test/live-continuation-native.test.ts | tee /tmp/pi-child-gates-r3-results.log | grep -E '(^[[:space:]]*✖|^ℹ|queue|provenance reads|junction substitution|selected transcript|assignment scan)'
npm run typecheck && npm run lint && git diff --check
```

Typecheck, lint i diff check zaliczone (zastane ostrzeżenie LF/CRLF). Pliki historycznie nieodebranego adaptera, jego bramki i testów pozostały nietknięte; ich cztery hashe nadal odpowiadają raportowi poprzedniego etapu. Nie ponawiano tamtego odbioru.

## Historyczny odbiór rodzica i usterka otwarta na koniec R3

Koordynator zakończył bez wymaganego `subagent_done`/`caller_ping`; harness zgłosił błąd i brak wyniku strukturalnego. Rodzic odzyskał końcowe dowody z zapisów oryginalnych sesji koordynatora i reviewera, bez uruchamiania kolejnej naprawy ani powtarzania historycznego review adaptera. Sprawdził zgodność bieżących blobów `index.ts` i `queue-child-allocation.ts` z wersją R3. Nie są to nowe testy wykonane przez rodzica.

**Potwierdzona usterka, medium:** `pi-extension/subagents/index.ts:2878–2890`, `live-continuation.ts:100–109,220–225`, `queue-child-allocation.ts:captureQueueChildFence`. Aktywne resume sprawdza proweniencję przed trwałym `RuntimeStore.continuation(...)`, ale nie ponawia sprawdzenia po tym zapisie i przed publikacją żądania. Dokładna karta kolejki dopisana do tego samego pliku podczas zapisu zamiaru może pozostać niewykryta; odbiorca ze wcześniej załadowaną listą wpisów również może ją przeoczyć. Niezależny reviewer w kontrolowanej próbie z zarejestrowanym resume i rzeczywistym watcherem uzyskał `continued`, jeden plik żądania i **jedno `sendUserMessage` zamiast zera**. Osobna próba zamkniętego resume z dopisaniem podczas zapisu intencji poprawnie dała zero wysyłek. To wykrywalna trwała zmiana przed publikacją, nie żądanie atomowej blokady przestrzeni nazw.

W R3 nie wykonano tej poprawki: wykorzystano trzy rundy napraw i nie odebrano całego etapu. Usterkę naprawiono później, zgodnie z sekcją „Poprawka po R3 — aktywne resume”. Naprawa nie włącza publicznego v2 ani kolejki.

Dowody: sesja koordynatora `24ec7a30-5567-482b-8b5b-3329d0cfdd1b` (kontynuacja `131a1228-b0b5-4551-b158-f243373ffce4`) i sesja reviewera `5a927f6b-5736-4417-9b26-20bf37c38723`. Reviewer: 164/164 obszarowe, typecheck, lint i diff check zaliczone; dodatkowa próba aktywnego resume niezaliczona. Koordynator: 896/896 pełne oraz typecheck, lint i diff check zaliczone. Liczników nie sumować.

## Bloby Git historycznej wersji R3 (sprzed poprawki)

| Plik | Hash |
|---|---|
| `pi-extension/subagents/assignment.ts` | `2f714db8ddc77fcf2cb4b192d6e690e84d1c863a` |
| `pi-extension/subagents/harness/drivers/pi.ts` | `413f0f6c6e6315eae7e25680cc6da098fd27f5f9` |
| `pi-extension/subagents/index.ts` (także zastane zmiany) | `04109ad5b67cc572bab9da264baf5488f0bbfef4` |
| `pi-extension/subagents/launch-profile.ts` | `c7806bc0d93e19a27f507b48781741c3fa85bd58` |
| `pi-extension/subagents/live-continuation.ts` | `f59ae66dd5d9ed71cccc39e742eebfba0697df78` |
| `pi-extension/subagents/queue-child-allocation.ts` | `a571b3b2807f88bfbc1d98ee262581aee681fe91` |
| `test/launch-profile.test.ts` | `da7a6933b4c3cbb6d9b08853f1d7e1e13b02d270` |
| `test/live-continuation.test.ts` | `c720118f2de45f73fe64a6d9d563d097d89e681c` |
| `test/ownership-execute.test.ts` (także zastane zmiany) | `489d138b40d547fa2ad50c690e714c5807c215fc` |
