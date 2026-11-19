# Przykład pracy z podagentami — od rozpoznania do commita

Ten dokument pokazuje jeden kompletny, praktyczny przepływ na przykładzie dodania mnożenia do kalkulatora. Jest przeznaczony do czytania przez człowieka: opisuje **kto co robi, w jakiej kolejności i co się dzieje, gdy kontrola nie przejdzie**.

> **W skrócie:** główny agent koordynuje. Podagenci wykonują ograniczone zadania i zwracają wyniki głównemu. Kolejność opisana w instrukcjach jest workflowem dla modelu — sama w sobie nie stanowi technicznej blokady.

## 1. Cel i podział ról

| Rola | Zadanie | Zakres zmian |
|---|---|---|
| **Główny agent** | Rozdziela pracę, przekazuje kontekst, ocenia wyniki i decyduje o następnym kroku. | Koordynuje; nie powinien po cichu rozszerzać zakresu. |
| **scout** | Rozpoznaje strukturę projektu, konwencje, pliki i komendy testowe. | Niczego nie zmienia. |
| **worker** | Implementuje mnożenie i dodaje testy automatyczne. | Kod i testy. |
| **reviewer** | Sprawdza zmiany względem wymagań, szuka błędów i ryzyk. | Niczego nie zmienia. |
| **tester** | Uruchamia testy i niezależnie sprawdza kryteria akceptacji. | Niczego nie zmienia. |
| **documenter** | Przygotowuje i finalizuje dokumentację użytkownika. | Dokumentacja. |
| **commiter** | Tworzy zatwierdzony lokalny commit. | Commit tylko zatwierdzonych plików; bez push. |

Podagenci nie przekazują sobie automatycznie zadań. Zwracają wyniki głównemu agentowi, który przygotowuje następne zlecenie.

## 2. Gdzie umieścić definicje

```text
~/.pi/agent/agents/
└── scout.md                         # rola globalna, wspólna dla projektów

projekt/
├── AGENTS.md                        # zasady koordynacji i kolejność etapów
└── .pi/
    └── agents/
        ├── worker.md
        ├── reviewer.md
        ├── tester.md
        ├── documenter.md
        └── commiter.md
```

Projektowe `.pi/agents/` musi być jawnie zatwierdzone jako zaufane źródło. Kolejność wyszukiwania definicji tej samej nazwy to: zatwierdzona definicja projektowa, globalna, a następnie dostarczona z pluginem. Definicja projektowa zastępuje definicję globalną o tej samej nazwie — nie łączy się z nią.

### Przykładowe ustawienia modeli

| Sesja / rola | Model | Reasoning |
|---|---|---|
| Główny | `openai-codex/gpt-5.6-terra` | `medium` |
| scout (globalny) | `openai-codex/gpt-5.6-terra` | `low` |
| worker | `openai-codex/gpt-6.1-sol` | `medium` |
| reviewer | `openai-codex/gpt-6-astra` | `high` |
| tester | `openai-codex/gpt-6.1-sol` | `medium` |
| documenter | `openai-codex/gpt-5.6-terra` | `low` |
| commiter | `openai-codex/gpt-5.6-terra` | `low` |

To przykładowe identyfikatory — wybierz dokładne modele dostępne i uwierzytelnione w swoim środowisku. Model można ustawić w definicji roli lub w konfiguracji modeli pluginu. Dla modelu kolejność pierwszeństwa to: argument uruchomienia → frontmatter wybranej roli → `models.agents` w konfiguracji pluginu → `models.default` → model głównej sesji. Dla reasoning: argument uruchomienia → frontmatter roli → poziom głównej sesji.

Nie musisz konfigurować każdego pola. Jeśli rola nie ma jawnego ustawienia, obowiązuje opisana wartość zapasowa. Zmiana modelu głównego nie nadpisuje jawnego modelu workera.

## 3. Jak definiować zachowanie ról

Każda rola to plik Markdown z frontmatter i instrukcją. Przykład `projekt/.pi/agents/worker.md`:

```markdown
---
name: worker
description: Implements assigned changes and fixes reported defects.
model: openai-codex/gpt-6.1-sol
thinking: medium
tools: read, bash, edit, write
session-mode: standalone
spawning: false
auto-exit: true
---

Implement only the coordinator's assignment.
Modify only assigned implementation and test files.
Add automated tests for the requested behavior and run them.
Do not modify documentation. Do not commit or push. Do not delegate.
Report changed files, commands and results, and known issues.
```

Pozostałe role powinny mieć równie wyraźne instrukcje:

- **scout:** tylko rozpoznanie; wskazuje ścieżki, konwencje i polecenia; nie edytuje.
- **reviewer:** zwraca `PASS` albo `FAIL`, wskazuje plik, problem i sposób odtworzenia; nie edytuje.
- **tester:** sprawdza kryteria niezależnie, podaje uruchomione komendy i wyniki; nie edytuje.
- **documenter:** edytuje wyłącznie wskazaną dokumentację; odróżnia szkic od wersji zatwierdzonej.
- **commiter:** wymaga jawnej zgody, listy ścieżek i komunikatu commita; sprawdza stan Git i nie używa `git add .`; nie robi push.

`tools` oraz instrukcje ograniczają zachowanie agenta, ale nie są pełną izolacją bezpieczeństwa. Agent mający dostęp do powłoki może technicznie wykonać więcej, niż mówi jego opis. Krytyczne ograniczenia trzeba egzekwować również uprawnieniami środowiska lub CI.

## 4. Kolejność pracy — workflow w `AGENTS.md`

Przykładowe zasady dla `projekt/AGENTS.md`:

```markdown
# Feature delivery workflow

The main agent coordinates all roles. Children report to the coordinator.

1. Check git status before work. Do not overwrite or include pre-existing user changes.
2. Run scout before assigning implementation.
3. Convert the request and scout findings into explicit acceptance criteria.
4. Start worker and documenter in parallel only when their file ownership is disjoint.
   Worker owns source and test files; documenter owns documentation files.
5. Do not start reviewer or tester until worker has finished and the coordinator
   has inspected the implementation handoff.
6. Reviewer and tester may run in parallel against the same implementation state.
   Tester receives the original acceptance criteria, not only the worker's report.
7. Do not change implementation while review and tests are running.
8. If either check fails, send actionable findings to worker. After corrections,
   rerun both review and tests against the corrected state. Earlier PASS results
   do not apply to changed code.
9. After code passes, have documenter finalize documentation. Check that it
   matches the accepted behavior.
10. Before commit, confirm that the reviewed and tested code has not changed,
    inspect the complete diff, and get user authorization for the exact paths.
11. Start commiter only after all gates pass. Local commit only; no push unless
    separately authorized.
12. If checks conflict, cannot run, exceed two repair rounds, or scope changes,
    stop and report the issue to the user. Do not treat an unrun check as PASS.
```

**Co `AGENTS.md` zapewnia?** Daje głównemu agentowi czytelne reguły kolejności. Nie sprawia, że plugin automatycznie zablokuje uruchomienie testera przed workerem. To główny agent ma sprawdzić warunki przed każdym etapem; twarde wymuszanie wymaga dodatkowego mechanizmu.

## 5. Przykładowe zlecenie

> Dodaj mnożenie do kalkulatora. Obsłuż liczby dodatnie, ujemne, zero i ułamki. Zachowaj istniejącą obsługę błędów. Zaktualizuj dokumentację. Pracuj według `AGENTS.md`. Po pozytywnym review i testach utwórz lokalny commit. Nie wykonuj push.

## 6. Przebieg krok po kroku

### Krok 0 — sprawdzenie stanu projektu

Główny agent sprawdza stan repozytorium i zauważa istniejące zmiany. Ustala, które zmiany należą do użytkownika. Nie czyści ich i nie włącza ich przypadkiem do commita.

### Krok 1 — scout rozpoznaje projekt

Główny uruchamia globalnego `scout` z konkretnym zadaniem:

> Znajdź implementację kalkulatora, testy i dokumentację. Sprawdź istniejące operatory, konwencje i komendy testowe. Niczego nie zmieniaj.

Przykładowy wynik:

```text
Kod: src/calculator.ts
Testy: test/calculator.test.ts
Dokumentacja: docs/calculator.md
Testy uruchamia: npm test
Obecne operatory: + i -
Nieznany operator zwraca błąd.
```

Główny agent na tej podstawie ustala kryteria, np. `2 * 3 = 6`, `-2 * 3 = -6`, `0 * 5 = 0`, poprawne ułamki oraz brak regresji dla dodawania i odejmowania.

### Krok 2 — worker i documenter pracują równolegle

**Worker** dostaje wymagania, kryteria, ścieżki do kodu i testów oraz zakaz modyfikowania dokumentacji.

**Documenter** dostaje ścieżkę do dokumentacji i może przygotować szkic, opisując wymagane zachowanie. Otrzymuje informację, że ma wrócić do dokumentacji po weryfikacji kodu.

Praca równoległa jest bezpieczna, bo role mają różne pliki. Jeśli okaże się, że muszą edytować ten sam plik, koordynator powinien ustawić kolejność zamiast ryzykować nadpisanie zmian.

Na tym etapie **tester nie startuje**: nie ma jeszcze zakończonej implementacji do sprawdzenia. Reviewer również czeka.

### Krok 3 — zakończenie workera i zamrożenie zakresu

Worker zwraca listę plików, opis zmian, uruchomione komendy i wyniki. Główny sprawdza, czy zmiany mieszczą się w przydzielonym zakresie. Zapisuje, jaką wersję zmian poddaje kontroli — na przykład odnotowuje diff albo identyfikator commita/snapshotu, jeśli jest dostępny.

Od tej chwili worker nie zmienia kodu, dopóki trwają review i testy.

### Krok 4 — tester i reviewer sprawdzają tę samą wersję

Główny uruchamia obie role równolegle:

- **reviewer** porównuje implementację z wymaganiami i szuka błędów;
- **tester** uruchamia testy oraz samodzielnie sprawdza kryteria, w tym przypadki brzegowe.

Przykładowy wynik pierwszej rundy:

```text
REVIEWER: FAIL
Powód: 0 * 5 jest odrzucane jako brak argumentu.
Oczekiwano: wynik 0.

TESTER: FAIL
npm test przechodzi, ale przypadek 0 * 5 nie przechodzi.
```

Sam fakt, że `npm test` przechodzi, nie wystarcza, jeżeli testy nie obejmują wymagań.

### Krok 5 — poprawka i ponowna weryfikacja

Główny przekazuje workerowi konkretne ustalenia:

> Napraw obsługę zera. Dodaj testy `0 * 5`, `5 * 0` i `0 * 0`. Nie zmieniaj zakresu innych operacji. Uruchom testy i podaj wynik.

Po poprawce reviewer i tester sprawdzają **nową wersję**. Poprzednie wyniki PASS/FAIL opisują poprzedni stan — nie są automatycznie aktualne.

```text
Worker: poprawka zakończona
Reviewer: PASS — poprawka spełnia wymagania
Tester: PASS — testy i kryteria akceptacji przechodzą
```

Jeśli review i testy nadal się nie zgadzają albo poprawki przekroczą ustalony limit, główny przerywa automatyczną pętlę i prosi użytkownika o decyzję.

### Krok 6 — documenter kończy tekst

Główny informuje documentera, jaki dokładnie kształt zachowania przeszedł kontrolę. Documenter finalizuje przykłady i opis, w tym mnożenie przez zero. Główny sprawdza zgodność dokumentacji z zaakceptowanym kodem.

W tym przykładzie documenter mógł pracować nad szkicem równolegle z workerem; wersję końcową dopina dopiero po poznaniu zaakceptowanego zachowania.

### Krok 7 — kontrola końcowa i commit

Przed commitem główny:

1. sprawdza, czy kod nie zmienił się po review i testach;
2. przegląda cały diff i oddziela zmiany użytkownika od zmian zadania;
3. potwierdza, że review, testy i dokumentacja dotyczą aktualnych plików;
4. przekazuje commiterowi dokładną listę zatwierdzonych ścieżek i komunikat.

Przykładowe zlecenie:

```text
Zgoda na lokalny commit.
Zatwierdzone pliki:
- src/calculator.ts
- test/calculator.test.ts
- docs/calculator.md
Review aktualnego kodu: PASS
Testy aktualnego kodu: PASS
Dokumentacja: zaakceptowana
Komunikat: feat: add calculator multiplication
Nie wykonuj push.
```

Commiter sprawdza Git, dodaje wyłącznie zatwierdzone pliki i zwraca hash commita. Jeśli widzi nieoczekiwane staged changes lub inne ścieżki, zatrzymuje się i zgłasza problem.

## 7. Schemat całego przepływu

```text
                    ┌─────────────────────┐
                    │ Sprawdź stan repozytorium │
                    └──────────┬──────────┘
                               ▼
                         ┌──────────┐
                         │  SCOUT   │  rozpoznanie, bez edycji
                         └────┬─────┘
                              ▼
                    Główny ustala kryteria
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
          ┌──────────┐                ┌─────────────┐
          │  WORKER  │                │ DOCUMENTER  │
          │ kod/testy│                │ szkic docs  │
          └────┬─────┘                └──────┬──────┘
               ▼                             │
      Implementacja gotowa                   │
               ▼                             │
       ┌───────┴────────┐                    │
       ▼                ▼                    │
 ┌──────────┐     ┌──────────┐                │
 │ REVIEWER │     │ TESTER   │                │
 └────┬─────┘     └────┬─────┘                │
      └──────┬─────────┘                     │
             │                                │
       FAIL  │  PASS                          │
        ▼    │   ▼                            │
     WORKER  │  Finalizacja dokumentacji ◄────┘
   poprawka  │             │
        └────┴─ ponowna    ▼
               weryfikacja Kontrola końcowa
                            │
                            ▼
                      ┌──────────┐
                      │ COMMITER │  lokalny commit, bez push
                      └──────────┘
```

## 8. Najważniejsze bramki i typowe luki

- **Tester przed workerem:** nie ma jeszcze gotowej implementacji; koordynator czeka. To reguła workflow, nie automatyczna blokada pluginu.
- **Nieudane review lub test:** brak commita; worker dostaje konkretne ustalenia; po zmianie powtarza się review i testy.
- **Kod zmieniony po PASS:** wcześniejszy wynik nie potwierdza nowego kodu; kontrolę trzeba powtórzyć.
- **Testy nieuruchomione:** wynik to „niezweryfikowane”, nie PASS.
- **Istniejące zmiany użytkownika:** nie wolno ich nadpisywać ani przypadkowo commitować.
- **Równoległe edycje tego samego pliku:** unikać; równoległość stosować przy rozłącznych zakresach.
- **Zbyt wiele nieudanych rund:** ustalić limit i eskalować do użytkownika zamiast naprawiać bez końca.
- **Zadanie krytyczne:** instrukcje ról nie zastępują CI, kontroli uprawnień ani izolacji środowiska.

## 9. Jak czytać ten przykład

- **Pliki agentów** opisują rolę, model, reasoning i narzędzia.
- **`AGENTS.md`** opisuje projektowy sposób koordynowania pracy.
- **Zlecenie użytkownika** określa cel i zgodę na działania, np. commit.
- **Główny agent** uruchamia role we właściwym momencie, przekazuje wyniki i decyduje o akceptacji.
- **Plugin** zapewnia mechanizm uruchamiania podagentów i dostarczania ich wyników; nie gwarantuje sam z siebie, że każdy krok biznesowego procesu został wykonany poprawnie.
