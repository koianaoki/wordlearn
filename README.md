# WordLearn

Solid + Vite で作成した英単語学習アプリです。

## GitHub Pages へのデプロイ

このリポジトリは GitHub Actions で `dist/` をビルドして Pages にデプロイします。

### 1. GitHub 側の設定

1. リポジトリの **Settings > Pages** を開く
2. **Build and deployment** の **Source** を **GitHub Actions** に変更

### 2. デプロイ方法

- `main` ブランチに push すると、`.github/workflows/deploy-pages.yml` が実行されます。
- ビルド成功後、GitHub Pages に公開されます。

公開URL:

- <https://koianaoki.github.io/wordlearn/>

## ローカル起動

```bash
npm ci
npm run dev
```

## ローカルビルド確認

```bash
npm run build
npm run preview
```
