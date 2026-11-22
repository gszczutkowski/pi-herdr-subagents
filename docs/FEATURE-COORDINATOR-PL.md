# Projekt: osobny koordynator dla każdej funkcjonalności

**Status: propozycja, nie zaimplementowano.** Cel: użytkownik raz podaje listę (np. F1–F5). Główna sesja Pi trzyma kolejność, zależności i decyzje; szczegóły implementacji i sprawdzania jednej funkcji pozostają w jej własnej sesji. Nie tworzymy pięciu niezależnych planów ani łańcucha agentów dziedziczących rozmowę.

## Przebieg

1. Na wyraźne zlecenie takiego trybu główna sesja zapisuje po jednym zadaniu na funkcję w istniejącym planie: zakres, zależności, kryteria odbioru i referencje. Domyślnie wykonuje **jedną funkcję naraz**, w kolejności zależności. Nie zmieniamy domyślnego zachowania `/plan` ani `/iterate`.
2. Dla gotowej funkcji rodzic rozpoczyna próbę i wywołuje `subagent` z `agent: "feature-coordinator"`, `planTask` bieżącej próby oraz jawnym katalogiem roboczym. Kontrakt przypisania już przenosi zakres i kryteria. Do `assignmentContract.decisions`, `files` i `changeConstraints` trafiają tylko ustalenia potrzebne dla tej funkcji. Bez `fork: true`.
3. Koordynator sprawdza dostępność narzędzia delegacji i potrzebnych ról. Zleca implementację i testy `worker`owi; `scout` tylko przy konkretnej niewiadomej, `reviewer` gdy wymaga tego ryzyko lub kryterium. Dzieci otrzymują wycinek zlecenia, **bez powiązania z próbą planu przodka**. Ich wyniki trafiają do koordynatora jako bezpośredniego rodzica. Nie uruchamia on koordynatora następnej funkcji, nie zatwierdza zadania i sam nie edytuje kodu.
4. Koordynator porównuje wynik z kryteriami, sprawdza referencje i zgłasza jeden wynik całej funkcji. Jeśli brakuje dowodu, wskazuje lukę zamiast deklarować sukces. Błąd lub blokadę wymagające decyzji zgłasza bez czekania na koniec listy.
5. Główna sesja weryfikuje wskazane dowody i podejmuje decyzję przez istniejące operacje planu (`evidence`, następnie `accept` dla wszystkich kryteriów). Tylko ona uruchamia kolejny świeży profil. `partial`, `blocked`, wynik nieustrukturyzowany albo niepewne dostarczenie nie odblokowują zależnych zadań. Niezależne zadanie można wybrać jawnie. Po restarcie: odczyt planu i zapisanych wyników, nie ponowny start w ciemno.

## Co dostaje następca

Użyć istniejącego `subagent_done({result, close: true})`, nie nowego typu wiadomości. `result` zawiera `status` (`complete` / `partial` / `blocked`), `summary`, `artifacts`, `checks`, `unmetCriterionIds`, `risks` zgodnie z [CONTRACTS.md](../CONTRACTS.md). `summary` ma odpowiadać na dwa pytania: **co zmieniło się dla następcy i na czym może on polegać?** W `checks` podajemy rzeczywiste identyfikatory kryteriów, wynik i sprawdzalną referencję (np. test + polecenie lub raport powiązany z badaną wersją). W razie blokady: czego brakuje i jaka decyzja jest potrzebna. Nie powtarzamy logu ani pełnego wyniku w końcowym tekście asystenta.

**Przykład fikcyjny: F1 dodaje eksport, F2 dodaje przycisk w UI.**

| Odbiorca | Przykładowa treść |
|---|---|
| Główna sesja, po F1 | `complete` (do odbioru). Eksport udostępnia `exportCsv(rows): string`, bez zapisu na dysk. Test kontraktu: `passed`; referencja do zapisanego raportu dla kryterium F1. Brak otwartych blokad. |
| Koordynator F2, dopiero po odbiorze F1 | „Dodaj przycisk zgodnie z kryteriami F2. Użyj `exportCsv(rows)` z `src/export.ts`; pobranie pliku należy do UI. Kontrakt: `test/export.test.ts`.” Bez raportu z review F1 i bez listy F3–F5. |

Rodzic zapisuje decyzję i trwałe referencje w planie, nie polega na pamięci rozmowy. Przekazuje tylko ustalenia z **zależności** następnego zadania, nie automatycznie ostatni raport. Referencje muszą być dostępne z katalogu odbiorcy. Gdy jest ich dużo, koordynator wskazuje zapisany przez workera raport zbiorczy; nie pomija brakujących kryteriów, żeby zmieścić się w limicie. Cel dla treści przekazania widocznej modelowi głównemu: ok. 2 KiB na typową funkcję (mierzyć w UTF-8, nie udawać licznika tokenów). Szczegóły na żądanie. Istniejący globalny `maxReportBytes` to oddzielne zabezpieczenie, nie ustawienie nowej roli.

## Zakres implementacji

- **Profil w pakiecie:** dodać `agents/feature-coordinator.md` z `session-mode: lineage-only`, `tools: read, grep, find, ls`, `spawning: true`, `auto-exit: false`, `interactive: false`, `system-prompt: append`. Nie przypinać modelu. To rola Pi; nie obiecywać działania z innym harness bez weryfikacji. W jednym katalogu tylko jeden worker modyfikuje kod naraz. Równoległe implementacje w osobnych worktree i integracja to rozszerzenie, nie warunek pierwszej wersji.
- **Polityka zakończenia tylko dla tego profilu:** dodać opt-in np. `completion-mode: explicit`. Dziś `pi-extension/subagents/subagent-done.ts` obsługuje także naturalne zakończenie tury `stop`; `auto-exit: false` może zostawić kartę otwartą, ale **nie wyłącza raportowania kolejnych zakończonych tur do rodzica**. Sam plik Markdown nie gwarantuje zatem ciszy po uruchomieniu workera. Nową opcję sparsować w definicji, utrwalić w `launch-profile.ts` i przekazać jawnie w `harness/drivers/pi.ts`, także przy wznowieniu. Brak pola w starych profilach = zachowanie dotychczasowe. Worker uruchomiony z roli koordynatora nie dziedziczy tej opcji.
- **Granica powiadomień:** w nowym trybie zwykły `stop` bez jawnego zakończenia pozostawia koordynatora w oczekiwaniu, bez wyniku i bez wybudzenia głównej sesji. Wynik dziecka nadal wybudza koordynatora; jawne zakończenie funkcji publikuje wynik standardowym kanałem po ustabilizowaniu tury. Nie wyciszać błędów dostawcy, awarii nadzoru ani jawnej prośby o pomoc. Nie stosować odpytywania, sztucznych wiadomości ani nowego kanału. Jeżeli koordynator skończy turę bez delegacji, wyniku lub blokady, obsłużyć to jako niepełne zlecenie wymagające decyzji, nie jako sukces ani milczące oczekiwanie bez źródła wznowienia. Przy błędzie nie uruchamiać zastępstwa, gdy los poprzedniego wykonawcy jest nieznany.
- **Instrukcja głównej sesji:** udokumentować tryb opt-in w `pi-extension/subagents/plan-skill.md` oraz przykład użytkownika w README. Nie dodawać schedulera, drugiego magazynu stanu ani obowiązkowej nowej komendy. Ograniczenia roli w prompcie są zasadami pracy, nie sandboxem.

## Kiedy uznać wdrożenie za gotowe

1. Test discovery i profilu: nowa rola jest dostępna; nowa sesja ma relację z rodzicem, ale nie odziedziczyła testowego znacznika z historii. Stary profil i zwykły `worker` działają jak dotąd; nowy tryb przeżywa zapis i wznowienie.
2. Test routingu: koordynator deleguje, jego tura się kończy, a rodzic nie otrzymuje wyniku pośredniego. Worker przekazuje wynik tylko koordynatorowi. Po jawnej finalizacji na zwykłej ścieżce rodzic odbiera jeden wynik funkcji. Osobno sprawdzić brakujący raport, błąd dostawcy i blokadę: żaden nie znika ani nie oznacza akceptacji.
3. Próba end-to-end na dwóch zależnych funkcjach w prawdziwej sesji Pi: dwie różne sesje koordynatorów; F2 startuje po odbiorze F1; widzi umowę interfejsu, lecz nie unikalny tekst z logu workera F1. Ścieżka negatywna: brak dowodu F1 zatrzymuje F2. Sprawdzić treść widoczną modelowi rodzica, nie tylko długość karty w TUI.
4. Próba listy pięciu zadań: pięć osobnych przypisań i brak rekurencyjnego uruchamiania koordynatorów. Porównać rozmiar wyników i liczbę tur **głównej sesji** z przekazywaniem pełnych raportów; ewentualny koszt całej hierarchii mierzyć osobno. Mniejszy kontekst rodzica nie gwarantuje mniejszego całkowitego kosztu.
