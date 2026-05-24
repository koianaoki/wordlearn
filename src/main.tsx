import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import words from "../data/words-ja-en.json";
import "./styles.css";

// 単語データ1件分の型。
// - id: 一意識別子
// - word: 英単語本体
// - ja: 日本語訳（複数訳を持てるよう配列）
type WordEntry = {
  id: number;
  word: string;
  ja: string[];
};

// 辞書APIからUI表示に必要な最小情報だけを切り出した型。
// 取得できない場合は呼び出し側でフォールバック文言を表示する。
type DictionaryResult = {
  example: string;
  phonetic: string;
};

// JSONを学習用配列として固定。
// アプリ起動中に内容が変わらないため、定数として保持する。
const ALL_WORDS = words as WordEntry[];

// ランダムに単語インデックスを返す関数。
// 直前と同じ単語を避けたいので exclude を受け取り、
// 一致した場合は再抽選する。
function getRandomIndex(exclude?: number): number {
  // 単語数0/1件のときは再抽選の意味がないため0固定。
  if (ALL_WORDS.length <= 1) {
    return 0;
  }

  let index = Math.floor(Math.random() * ALL_WORDS.length);
  while (index === exclude) {
    index = Math.floor(Math.random() * ALL_WORDS.length);
  }
  return index;
}

// Free Dictionary API から発音・例文を取得する。
// 失敗時は null を返して、UI側でローカル表示にフォールバックする。
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

    // phonetic がトップレベルにない場合があるため、
    // phonetics 配列から最初に text を持つ要素を探す。
    const phonetic =
      entry.phonetic ||
      entry.phonetics?.find((p: { text?: string }) => p.text)?.text ||
      "発音情報なし";

    // 例文は meanings[].definitions[].example に散在しているため
    // 二重ループで先頭の例文を1件だけ採用する。
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
    // ネットワーク障害・CORS・JSON不正などはすべて null へ統一。
    return null;
  }
}

function App() {
  // 現在表示中の単語インデックス。
  const [currentIndex, setCurrentIndex] = createSignal(getRandomIndex());
  // カード表裏フラグ。false=表（単語のみ）, true=裏（詳細）
  const [flipped, setFlipped] = createSignal(false);
  // API取得結果。未取得または失敗時は null。
  const [dictionary, setDictionary] = createSignal<DictionaryResult | null>(null);
  // 裏面表示時のAPI通信中フラグ。
  const [loading, setLoading] = createSignal(false);
  // スワイプ開始位置（x座標）。
  const [startX, setStartX] = createSignal<number | null>(null);

  // 現在インデックスから表示単語を導出。
  const currentWord = createMemo(() => ALL_WORDS[currentIndex()]);

  // 現在単語の辞書情報をロードする。
  const loadWordDetails = async () => {
    setLoading(true);
    const result = await fetchDictionary(currentWord().word);
    setDictionary(result);
    setLoading(false);
  };

  // カードを次のランダム単語へ切り替える。
  // direction は将来的なアニメーション制御拡張用に保持。
  const moveCard = (direction: "left" | "right") => {
    void direction;
    const index = getRandomIndex(currentIndex());
    setCurrentIndex(index);
    // 単語切替時は必ず表面に戻し、前単語のAPI結果を破棄する。
    setFlipped(false);
    setDictionary(null);
  };

  // タップ時に表裏を切り替える。
  // 裏面へ遷移する瞬間のみ辞書APIを呼び出す（不要な再取得防止）。
  const onFlip = async () => {
    const nextFlipped = !flipped();
    setFlipped(nextFlipped);
    if (nextFlipped && !dictionary()) {
      await loadWordDetails();
    }
  };

  // ポインタ押下時点のx座標を記録。
  const onPointerDown = (event: PointerEvent) => {
    setStartX(event.clientX);
  };

  // ポインタ解放時に移動量を評価し、閾値超過ならスワイプ判定。
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
    // ドキュメント全体で pointerup を監視して、
    // カード外で指を離したケースも確実に拾う。
    document.addEventListener("pointerup", onPointerUp);
  });

  onCleanup(() => {
    // コンポーネント破棄時のイベントリーク防止。
    document.removeEventListener("pointerup", onPointerUp);
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
        <Show when={flipped()} fallback={<h2 class="word">{currentWord().word}</h2>}>
          <div class="details">
            <h2>{currentWord().word}</h2>
            <p>
              <strong>日本語訳:</strong> {currentWord().ja.join(" / ")}
            </p>
            <Show when={!loading()} fallback={<p>辞書APIから取得中...</p>}>
              <p>
                <strong>発音:</strong> {dictionary()?.phonetic ?? "発音情報なし"}
              </p>
              <p>
                <strong>例文:</strong> {dictionary()?.example ?? "例文なし"}
              </p>
            </Show>
          </div>
        </Show>
      </section>
      <p class="count">登録語数: {ALL_WORDS.length}語</p>
    </main>
  );
}

render(() => <App />, document.getElementById("root")!);
