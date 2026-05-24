import { createMemo, createSignal, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import words from "../data/words-ja-en.json";
import "./styles.css";

type WordEntry = {
  id: number;
  word: string;
  ja: string[];
};

type DictionaryResult = {
  example: string;
  phonetic: string;
};

const ALL_WORDS = words as WordEntry[];

function getRandomIndex(exclude?: number): number {
  if (ALL_WORDS.length <= 1) {
    return 0;
  }

  let index = Math.floor(Math.random() * ALL_WORDS.length);
  while (index === exclude) {
    index = Math.floor(Math.random() * ALL_WORDS.length);
  }
  return index;
}

async function fetchDictionary(word: string): Promise<DictionaryResult | null> {
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const entry = Array.isArray(data) ? data[0] : null;
    if (!entry) {
      return null;
    }

    const phonetic =
      entry.phonetic ||
      entry.phonetics?.find((p: { text?: string }) => p.text)?.text ||
      "発音情報なし";

    const meanings = entry.meanings ?? [];
    let example = "例文なし";
    for (const meaning of meanings) {
      for (const definition of meaning.definitions ?? []) {
        if (definition.example) {
          example = definition.example;
          break;
        }
      }
      if (example !== "例文なし") {
        break;
      }
    }

    return { phonetic, example };
  } catch {
    return null;
  }
}

function App() {
  const [currentIndex, setCurrentIndex] = createSignal(getRandomIndex());
  const [flipped, setFlipped] = createSignal(false);
  const [dictionary, setDictionary] = createSignal<DictionaryResult | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [startX, setStartX] = createSignal<number | null>(null);

  const currentWord = createMemo(() => ALL_WORDS[currentIndex()]);

  const loadWordDetails = async () => {
    setLoading(true);
    const result = await fetchDictionary(currentWord().word);
    setDictionary(result);
    setLoading(false);
  };

  const moveCard = (direction: "left" | "right") => {
    const index = getRandomIndex(currentIndex());
    setCurrentIndex(index);
    setFlipped(false);
    setDictionary(null);
  };

  const onFlip = async () => {
    const nextFlipped = !flipped();
    setFlipped(nextFlipped);
    if (nextFlipped && !dictionary()) {
      await loadWordDetails();
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    setStartX(event.clientX);
  };

  const onPointerUp = (event: PointerEvent) => {
    const firstX = startX();
    if (firstX === null) return;

    const deltaX = event.clientX - firstX;
    const threshold = 50;
    if (Math.abs(deltaX) >= threshold) {
      moveCard(deltaX > 0 ? "right" : "left");
    }
    setStartX(null);
  };

  onMount(() => {
    document.addEventListener("pointerup", onPointerUp);
  });

  return (
    <main class="app">
      <h1>WordLearn 2000</h1>
      <p class="help">タップで詳細表示 / 左右スワイプで次のランダム単語</p>
      <section
        class={`card ${flipped() ? "flipped" : ""}`}
        onPointerDown={onPointerDown}
        onClick={onFlip}
      >
        <Show
          when={flipped()}
          fallback={<h2 class="word">{currentWord().word}</h2>}
        >
          <div class="details">
            <h2>{currentWord().word}</h2>
            <p><strong>日本語訳:</strong> {currentWord().ja.join(" / ")}</p>
            <Show when={!loading()} fallback={<p>辞書APIから取得中...</p>}>
              <p><strong>発音:</strong> {dictionary()?.phonetic ?? "発音情報なし"}</p>
              <p><strong>例文:</strong> {dictionary()?.example ?? "例文なし"}</p>
            </Show>
          </div>
        </Show>
      </section>
      <p class="count">登録語数: {ALL_WORDS.length}語</p>
    </main>
  );
}

render(() => <App />, document.getElementById("root")!);
