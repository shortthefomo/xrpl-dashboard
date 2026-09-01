# xrpl-dashboard

Live-ops wall for the XRP Ledger: spectrogram of proposed vs validated transactions, UNL vs other validations, dropped txs, and the last 256 ledgers.

Default websocket is Ripple’s public cluster (`wss://s1.ripple.com/`, failover to `s2`). A local `xrpld` still works via the Vite WS bridge.

## Run

```bash
npm install
npm run dev
```

Open [http://localhost:5180/](http://localhost:5180/).

| Source | URL |
| --- | --- |
| Public (default) | http://localhost:5180/ |
| Local node (`ws://127.0.0.1:6006`) | http://localhost:5180/?ws=/xrpl-ws |
| Any websocket | http://localhost:5180/?ws=wss://… |

```bash
# point the /xrpl-ws bridge at a different local node
XRPL_WS=ws://127.0.0.1:6006 npm run dev
```

## Stack

Vue 3 + Vite + [xrpl.js](https://github.com/XRPLF/xrpl.js). Subscribes to `ledger`, `transactions`, `transactions_proposed`, `validations`, and `manifests`. UNL keys come from [vl.ripple.com](https://vl.ripple.com) when the server has no admin `validators` command (Clio / public cluster).
