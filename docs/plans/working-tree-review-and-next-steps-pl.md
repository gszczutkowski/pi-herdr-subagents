# Przegląd bieżących zmian i plan dalszych prac

**Werdykt: wymagane zmiany przed mergem. Publiczne ready-order v2 pozostaje wyłączone.**

Zakres: lokalne drzewo robocze `main` względem `f74d605`, razem z nowymi, jeszcze nieśledzonymi plikami. Ten dokument podsumowuje aktualny przegląd, nie wdraża napraw i nie zastępuje raportów poszczególnych etapów. Poprzednie wyniki PASS dotyczą zakresu i wersji wskazanych w tamtych raportach.

## Ustalenia przeglądu

### P1 · Zamknięte `subagent_resume`: zapisano zamiar, ale nie wywołano transportu

W [`index.ts:2998–3002`](../../pi-extension/subagents/index.ts#L2998) zamknięte wznowienie zapisuje `dispatch-intent`, a następnie ponownie sprawdza obraz profilu i transkryptu. Ta ostatnia kontrola może odrzucić operację, zanim terminal dostanie polecenie. Obsługa błędu prawidłowo zapisuje `before-send`, ale [`dispatch-recovery.ts`](../../pi-extension/subagents/dispatch-recovery.ts#L210) rozpoznaje taki dowód tylko dla `prepared`; podobne założenie stosują [raport incydentu](../../pi-extension/subagents/dispatch-recovery.ts#L337) i [sprawdzenie dowodu niewysłania](../../pi-extension/subagents/dispatch-recovery.ts#L54) używane przez nadzór.

W dwóch kontrolowanych próbach reviewera **nie było żadnej wysyłki do terminala**:

| Dowód zachowany po odmowie | Zaobserwowany wynik | Skutek |
| --- | --- | --- |
| Kanoniczny wpis w outboxie | `dispatch-unknown / DISPATCH_INTENT` | Jawne wznowienie tej sesji pozostaje zablokowane, mimo zachowanego dowodu niewysłania. |
| Niezależny dziennik po dodatkowym błędzie zapisu manifestu | `still-blocked / EVIDENCE_CONFLICT`, także po przywróceniu zapisu | Rozliczenie nie przyjmuje dowodu; blokada magazynu obejmuje również niezależne starty. |

**Kierunek naprawy:** zachować ostatnią kontrolę plików. Zapisać i rozpoznawać pod dokładnym wiązaniem runu dowód „zamiar zapisano, wywołanie transportu nie nastąpiło” w outboxie, imporcie dziennika i nadzorze. Sam `dispatch-intent` bez dowodu, dane sprzeczne oraz możliwa wysyłka nadal nie uprawniają do ponowienia. Rozliczenie metadanych nie wysyła polecenia do terminala; nowa próba to osobna, jawna decyzja.

### P3 · Dwa problemy ze stabilnością testów

- [`test/runtime-recovery.test.ts:244`](../../test/runtime-recovery.test.ts#L244): test restartu czyści `PI_SUBAGENT_ID`, ale nie `PI_SUBAGENT_SESSION`. Uruchomiony z sesji delegowanej może dostać odmowę dostępu właściwą dla dziecka zamiast sprawdzać oczekiwane `already owned`. Wyczyścić oba markery w fixture starego i nowego rodzica; nie zmieniać reguł autoryzacji w produkcji.
- [`test/plan-queue.test.ts:133`](../../test/plan-queue.test.ts#L133): w równoległym przebiegu `firstReadyTaskId` raz zwróciło `undefined`, po czym test przeszedł w kolejnym przebiegu. Projekcja ma rzeczywisty [limit 150 ms na wywołanie Gita](../../pi-extension/subagents/plan-queue-work-area.ts#L68). Oddzielić deterministyczny test kolejności od testu timeoutu i sprawdzić stabilność pod obciążeniem; nie traktować timeoutu jako dowodu braku gotowych zadań.

## Co jeszcze jest do zrobienia — kolejność dostawy

### 1. Odblokować i zweryfikować ścieżkę v1

- [ ] Naprawić P1 i dodać regresje: kanoniczny outbox; opóźniony import z dziennika po odzyskaniu zapisu; powtórne reconcile bez duplikatu; restart z samym `dispatch-intent`, bez dowodu. Sprawdzać status, tożsamość runu i liczbę wywołań transportu, nie tylko tekst komunikatu. Sprawdzić wariant z aktywnym supervisorem i bez niego oraz niezależny start po odzyskaniu magazynu.
- [ ] Ustabilizować oba testy P3. Uruchomić pełne `npm test`, typecheck, lint i `git diff --check`; zlecić niezależny przegląd napraw na tej samej wersji.
- [ ] Z [planu odporności manifestu Windows](runtime-manifest-eperm.md) pozostało domknąć odbiór na docelowej wersji: scenariusz spawn/resume/reconcile w izolowanej sesji Pi/herdr, kontrolę regresji na Linuxie i pomiar opóźnienia UI przy wielu zapisach. Natywny test z uchwytem bez `FILE_SHARE_DELETE` przeszedł; nie ustala przyczyny pierwotnej blokady na maszynie użytkownika.

### 2. Osobno odebrać kontrolę własnych dzieci koordynatora

- [ ] Dokończyć niezależny przegląd i próbę live: koordynator audytuje i wznawia własnego workera, odbiera jego poprawkę lokalnie i wysyła do rodzica dopiero końcowy raport albo konkretną prośbę o decyzję. Sprawdzić odmowy dla obcej sesji i po utracie władzy nad gałęzią. Celowane testy automatyczne nie zastępują live.
- [ ] Zachować granicę wiązania próby przy resume. Odrębne ograniczenie opisane w [raporcie koordynatora](coordinator-own-child-capabilities-implementation.md#parent-verification-and-review-blocker) nie oznacza zgody na przepisanie `PlanTaskBinding` po retry. Zapisany profil nie zyskuje nowych narzędzi przez wznowienie.

### 3. Domknąć bramki ready-order v2, zanim narzędzia uzyskają możliwość wysyłki

- [ ] Dopiąć pierwszą wysyłkę. [`queue-launch-gate.ts`](../../pi-extension/subagents/queue-launch-gate.ts#L40) sprawdza katalog z przygotowanego profilu, ale [pozytywny test transportu](../../test/dispatch-failure.test.ts#L369) używa profilu bez przydziału kolejki. Przed podłączeniem narzędzi wymagać zgodnego przydziału w przygotowanym profilu Pi i testować zero wysyłek dla profilu bez niego lub z niezgodnymi danymi. Domknąć odbiór adaptera runtime i bramki pierwszej wysyłki.
- [ ] Dodać zaufaną autoryzację potomków i aktywnego wznowienia między procesami. Powiązać ją z konkretną sesją, próbą, runem i przydziałem; sprawdzać aktualną pauzę, władzę nad gałęzią, stan zapisu, rzeczywisty katalog i tryb pracy przy granicy wysyłki. Oznaczony profil rozpoznaje przydział, ale sam go nie autoryzuje. Brak aktualnego dowodu nadal ma oznaczać odmowę.
- [ ] Dodać rozliczenie całego drzewa wykonania. Bezpośredni właściciel zamyka możliwość dalszych wysyłek i utrwala rozliczenie swoich dzieci. Dopiero zweryfikowany brak nierozliczonych wykonawców i wysyłek pozwala rodzicowi zwolnić rezerwację. `complete`, zniknięcie panelu, żądanie przerwania i śmierć samego koordynatora nie są takim dowodem.

### 4. Udostępnić i zweryfikować v2 po spełnieniu powyższych warunków

- [ ] Podłączyć publiczny opt-in i komendy kolejki, stronicowany `plan_read` z `nextActions`, `/plan-view next` oraz instrukcje dla rodzica i koordynatora. Widoki nie uruchamiają pracy i nie budzą modelu.
- [ ] Dokończyć trwałe decyzje naprawcze: agregacja rund dziecka u koordynatora, limit trzech rund po review i brak ponownej wysyłki po otrzymaniu zduplikowanej decyzji.
- [ ] Zaliczyć [T01–T12](ready-order-next-action-spec-pl.md#7-kolejność-dostawy-i-odbiór) z licznikami transportu oraz scenariusz live Pi/herdr: lokalna naprawa A, start niezależnego C przy dostępnym miejscu, brak startu zależnego B i powrót do A po decyzji. Testy i niezależny końcowy review mają dotyczyć tej samej wersji; dopiero potem włączyć funkcję. Uzupełnić `CONTRACTS.md` i `docs/REFERENCE.md` przy udostępnieniu API.

## Stan weryfikacji

Windows, Node `v24.21.0`:

| Sprawdzenie | Wynik w tym przeglądzie |
| --- | --- |
| `npm run typecheck`, `npm run lint`, `git diff --check` | Zaliczone; Git zgłosił ostrzeżenie LF/CRLF w istniejącym pliku testowym. |
| `ownership-execute`, `live-continuation`, `provenance-view` | **90/90** zaliczonych. |
| `plan-queue`, `queue-dispatch-proof`, `runtime-manifest-windows` | **32/32** zaliczonych w osobnym przebiegu; wcześniej wystąpiło opisane wyżej niepowodzenie worktree. |
| `dispatch-recovery` | **24/24** zaliczonych w osobnym przebiegu. Dwie dodatkowe próby reviewera, spoza istniejącej suity, odtworzyły P1. |
| Pełne `npm test` | Próby przekroczyły limit, najdłuższa po **245 s**; brak aktualnego pełnego wyniku. Historyczne **899/899** z raportu bramek nie zastępuje tego przebiegu. |
| Live Pi/herdr, Linux, pełna macierz ready-order | Nie zweryfikowano w tym przeglądzie. |

Punkty odniesienia do ocenianej wersji (bloby `git hash-object`): `index.ts` — `6fd2f436aafd647dbaed090e7fccea7a41df7a93`; `runtime-store.ts` — `49a98f2cf9e1855664392a19c01bb7a1f489dbe2`; `dispatch-recovery.ts` — `a84ac51f96a2ae1801d04f3e6157217cb4b8aa51`; `queue-launch-gate.ts` — `e804d70e772e4fbf422c320e42d6729e0c6e9d19`.

Powiązane: [wcześniejsze ustalenia dispatch/recovery](dispatch-recovery-review-pl.md), [raport bramki wysyłki i adaptera](ready-order-runtime-gate-report-pl.md), [raport bramek dziecka i aktywnego wznowienia](ready-order-child-gates-report-pl.md), [specyfikacja ready-order](ready-order-next-action-spec-pl.md).
