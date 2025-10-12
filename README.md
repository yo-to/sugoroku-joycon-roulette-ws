# sugoroku-joycon-roulette-ws
石巻ハッカソン2025の最終版（ルーレットコントローラーを扱う部分）のソースなどのリポジトリです

## セットアップ

### Joy-Con とのペアリング

Joy-Con（R）を PC とペアリングして、以下のルーレットコントローラーに Joy-Con をセットしておく

●コントローラ ｜ 人生ゲームがNintendo Switchで登場！/パーティーゲームで盛り上がろう！  
https://www.takaratomy.co.jp/products/jinseidigital/qa/


### パッケージのインストールと起動

以下のパッケージをインストール

```zsh
npm i node-hid express ws winston
```

以下で ルーレットコントローラーを扱う WebSocket サーバーを起動

```zsh
node roulette.mjs
```zsh

#### デバッグ用の仕組み

デバッグ用に 2種類のクライアントを準備しています。上記の WebSocketサーバーを起動した状態で、ブラウザで http://localhost:8080/ にアクセスするか、または、以下のコマンドでデータ受信用の WebSocketクライアントを起動することで、受信データを確認できます。

```zsh
node client.js
```zsh
