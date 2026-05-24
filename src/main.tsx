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
  audioUrl: string | null;
};

// Web Speech API の対応状態を UI で扱うための列挙型。
// true/false の真偽値ではなく文字列リテラル型にすることで、
// 将来的に "loading" などの中間状態を追加しても読みやすさを保てる。
type SpeechSupportState = "supported" | "unsupported";

// JSONを学習用配列として固定。
// アプリ起動中に内容が変わらないため、定数として保持する。
const ALL_WORDS = words as WordEntry[];

// スワイプ成立に必要な距離。
// 以前より長めにして、誤操作を減らす。
const SWIPE_THRESHOLD = 80;

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

    // Free Dictionary API の音声は phonetics[].audio に入る。
    // 空文字が混在するケースがあるため、最初に「実際に再生可能な文字列」を持つ要素だけを採用する。
    // 先頭が // のURLは https 補完が必要なのでこの段階で正規化しておく。
    const rawAudio = entry.phonetics?.find((p: { audio?: string }) => p.audio)?.audio ?? "";
    const audioUrl = rawAudio
      ? rawAudio.startsWith("//")
        ? `https:${rawAudio}`
        : rawAudio
      : null;

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

    return { phonetic, example, audioUrl };
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

  // Web Speech API のサポート状態。初期値は未対応扱いにして、
  // onMount 内の実環境判定後に supported へ更新する。
  const [speechSupport, setSpeechSupport] = createSignal<SpeechSupportState>("unsupported");
  // 音声読み上げ中かどうか。UIボタン文言と disable 条件に使う。
  const [isSpeaking, setIsSpeaking] = createSignal(false);
  // 辞書APIの音声再生で使う Audio インスタンス。
  // 単語切替時に古い再生を止める必要があるため、関数内ローカルではなく参照を保持する。
  let dictionaryAudio: HTMLAudioElement | null = null;

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
  // カードは回転させず、水平移動のみで追従させる。
  // 進捗率は 0.0〜1.0 に丸め、しきい値到達の判定にも使う。
  const swipeProgress = createMemo(() => Math.min(Math.abs(dragDeltaX()) / SWIPE_THRESHOLD, 1));
  const reachedSwipeThreshold = createMemo(() => swipeProgress() >= 1);
  // 閾値を超えた分の差分を表示するため、超過分(px)を算出する。
  const swipeExcessPx = createMemo(() => Math.max(0, Math.abs(dragDeltaX()) - SWIPE_THRESHOLD));

  // 読み上げを停止する共通関数。
  // 単語切替・コンポーネント破棄・ユーザー手動停止の3系統から呼び出すため、
  // 停止処理を1か所へ集約して状態不整合を避ける。
  const stopSpeech = () => {
    // 辞書API音声を先に止める。
    // SpeechSynthesis と同時に鳴ってしまう事故を避けるため、
    // 「停止」は常に両方へ適用する共通処理として扱う。
    if (dictionaryAudio) {
      dictionaryAudio.pause();
      dictionaryAudio.currentTime = 0;
      dictionaryAudio = null;
    }

    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
  };

  // 現在表示単語を読み上げる。
  // 非対応ブラウザではこの関数を実行しない設計だが、
  // 念のため二重チェックして安全に no-op で抜ける。
  const playSpeech = () => {
    // まず辞書API音声を優先する。
    // ネイティブに近い発音が手に入る場合はそちらを使い、
    // URLが無い場合のみ従来のWeb Speech APIへフォールバックする。
    const audioUrl = dictionary()?.audioUrl;
    if (audioUrl) {
      stopSpeech();
      dictionaryAudio = new Audio(audioUrl);
      dictionaryAudio.onplay = () => setIsSpeaking(true);
      dictionaryAudio.onended = () => {
        setIsSpeaking(false);
        dictionaryAudio = null;
      };
      dictionaryAudio.onerror = () => {
        // API音声の再生に失敗した時だけ、Web Speech APIへ自動フォールバックする。
        // これにより音声URL切れ・CORS制約がある環境でも最低限の読み上げ体験を維持する。
        dictionaryAudio = null;
        setIsSpeaking(false);
        playSpeechWithWebApi();
      };
      void dictionaryAudio.play().catch(() => {
        // ユーザー操作直後でも端末ポリシーで拒否される場合があるため、
        // Promise reject 時も同じくWeb Speechへフォールバックする。
        dictionaryAudio = null;
        setIsSpeaking(false);
        playSpeechWithWebApi();
      });
      return;
    }

    playSpeechWithWebApi();
  };

  // Web Speech API による読み上げ専用処理。
  // playSpeech 本体から分離し、辞書音声失敗時のフォールバック先を明確化する。
  const playSpeechWithWebApi = () => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    // 既存キューをキャンセルして、常に「今の単語だけ」を読む。
    // これにより連打時に古い単語が遅れて再生される問題を防止する。
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(currentWord().word);
    utterance.lang = "en-US";
    utterance.rate = 0.95;

    // 再生開始・終了・エラー時にUI状態を同期する。
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);

    window.speechSynthesis.speak(utterance);
  };

  // 再生ボタン押下時の挙動。
  // 再生中なら停止、停止中なら再生にトグルする。
  const onClickSpeechButton = () => {
    if (isSpeaking()) {
      stopSpeech();
      return;
    }
    playSpeech();
  };

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
    // カード切り替え時は、前単語の読み上げを必ず停止する。
    // ユーザー体験として「表示単語と音声がずれる」状態を防ぐ。
    stopSpeech();
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
    // 実行環境がブラウザかつ speechSynthesis を実装しているか判定する。
    // この結果をそのまま再生ボタンの disabled 条件へつなげる。
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      setSpeechSupport("supported");
    }

    // ドキュメント全体で pointerup を監視して、
    // カード外で指を離したケースも確実に拾う。
    document.addEventListener("pointerup", onPointerUp);
  });

  onCleanup(() => {
    // コンポーネント破棄時のイベントリーク防止。
    document.removeEventListener("pointerup", onPointerUp);
    // 画面遷移やアンマウント時に読み上げだけ残らないよう停止する。
    stopSpeech();
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
          transform: `translateX(${cardTranslateX()}px)`
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
                ? "✅ スワイプ閾値到達: 指を離すとスワイプ確定"
                : "➡️ 水平スワイプ中: さらに引くとスワイプ確定"}
            </p>
            <p>
              距離: {Math.round(Math.abs(dragDeltaX()))} / {SWIPE_THRESHOLD}px（
              {Math.round(swipeProgress() * 100)}%）
            </p>
            <Show when={reachedSwipeThreshold()}>
              {/* スワイプ成立時に、閾値をどれだけ超えたか差分を明示する。 */}
              <p>
                閾値超過差分: +{Math.round(swipeExcessPx())}px
              </p>
            </Show>
            <Show when={!reachedSwipeThreshold()}>
              {/* まだ成立していない間は、成立までの残り差分を表示する。 */}
              <p>
                成立まであと: {Math.max(0, SWIPE_THRESHOLD - Math.round(Math.abs(dragDeltaX())))}px
              </p>
            </Show>
          </div>
        </Show>
      </section>

      {/*
        再生ボタンは「カード外」に配置して、
        カードのタップ（表裏反転）ジェスチャーと操作領域を明確に分離する。
      */}
      <button
        class="speak-button"
        type="button"
        disabled={speechSupport() === "unsupported"}
        onClick={onClickSpeechButton}
      >
        {speechSupport() === "unsupported"
          ? "このブラウザは音声再生に非対応です"
          : isSpeaking()
            ? "音声を停止"
            : "単語を再生"}
      </button>

      <p class="count">登録語数: {ALL_WORDS.length}語</p>
    </main>
  );
}

render(() => <App />, document.getElementById("root")!);
