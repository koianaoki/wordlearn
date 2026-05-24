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

// スワイプ成立に必要な距離。
// 以前より長めにして、誤操作を減らす。
const SWIPE_THRESHOLD = 110;

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

  // スワイプ開始位置（x座標）と現在位置との差分。
  // 差分はカードの見た目（傾き・平行移動）と、スワイプ進捗表示に使う。
  const [startX, setStartX] = createSignal<number | null>(null);
  const [dragDeltaX, setDragDeltaX] = createSignal(0);

  // 「いまスワイプ操作中か」「今回のポインタ操作でスワイプ成立済みか」を保持。
  // tap判定と競合しやすいので分離して管理し、裏面表示中でも確実にスワイプ優先にする。
  const [isDragging, setIsDragging] = createSignal(false);
  const [didSwipeOnThisPointer, setDidSwipeOnThisPointer] = createSignal(false);

  // 現在インデックスから表示単語を導出。
  const currentWord = createMemo(() => ALL_WORDS[currentIndex()]);

  // 表示するカード移動量は、極端に遠くまで引っ張っても見た目が破綻しないよう上限を設ける。
  const cardTranslateX = createMemo(() => Math.max(-140, Math.min(140, dragDeltaX())));
  // 左右に引いた方向へ軽く回転させ、「ページをめくっている感」を強める。
  const cardRotateDeg = createMemo(() => cardTranslateX() / 14);
  // 進捗率は 0.0〜1.0 に丸め、しきい値到達の判定にも使う。
  const swipeProgress = createMemo(() => Math.min(Math.abs(dragDeltaX()) / SWIPE_THRESHOLD, 1));
  const reachedSwipeThreshold = createMemo(() => swipeProgress() >= 1);

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
    // 直前のポインタ操作でスワイプが成立した場合、clickで裏返さない。
    // これで「スワイプしたのに翻訳表示へ切り替わる」誤動作を防ぐ。
    if (didSwipeOnThisPointer()) {
      return;
    }

    const nextFlipped = !flipped();
    setFlipped(nextFlipped);
    if (nextFlipped && !dictionary()) {
      await loadWordDetails();
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    // pointer capture により、指/マウスがカード外に出ても move/up を取り続ける。
    // 裏面のテキスト上をなぞった場合でも同じ一連操作として扱える。
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setStartX(event.clientX);
    setDragDeltaX(0);
    setIsDragging(true);
    setDidSwipeOnThisPointer(false);
  };

  const onPointerMove = (event: PointerEvent) => {
    const firstX = startX();
    if (firstX === null || !isDragging()) return;

    // リアルタイム差分を保持してUIに反映。
    setDragDeltaX(event.clientX - firstX);
  };

  const onPointerUp = () => {
    const deltaX = dragDeltaX();

    if (Math.abs(deltaX) >= SWIPE_THRESHOLD) {
      setDidSwipeOnThisPointer(true);
      moveCard(deltaX > 0 ? "right" : "left");
    }

    setStartX(null);
    setDragDeltaX(0);
    setIsDragging(false);
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
      <p class="help">
        タップで詳細表示 / 左右スワイプで次のランダム単語（スワイプ距離は {SWIPE_THRESHOLD}px）
      </p>
      <section
        class={`card ${flipped() ? "flipped" : ""} ${isDragging() ? "dragging" : ""}`}
        style={{
          transform: `translateX(${cardTranslateX()}px) rotate(${cardRotateDeg()}deg)`
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
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

        <Show when={isDragging()}>
          <div class="swipe-indicator">
            <p>
              {reachedSwipeThreshold()
                ? "✅ ページめくり閾値到達: 指を離すとスワイプ確定"
                : "📖 ページめくり中: さらに引くとスワイプに切り替わります"}
            </p>
            <p>
              距離: {Math.round(Math.abs(dragDeltaX()))} / {SWIPE_THRESHOLD}px（
              {Math.round(swipeProgress() * 100)}%）
            </p>
          </div>
        </Show>
      </section>
      <p class="count">登録語数: {ALL_WORDS.length}語</p>
    </main>
  );
}

render(() => <App />, document.getElementById("root")!);
