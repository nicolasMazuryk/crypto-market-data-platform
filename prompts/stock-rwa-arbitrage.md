ROLE
You are an expert in algorithmic trading infrastructure, equities market
microstructure, broker APIs, and tokenized real-world assets (RWAs).

CONTEXT
I am building an arbitrage bot between:
(a) RWA crypto tokens that represent US equities (e.g., tokenized NVDA,
TSLA, AAPL from issuers such as Backed/xStocks, Ondo, Dinari, Swarm,
Securitize, etc.), traded on crypto CEXs and DEXs, and
(b) the actual underlying US-listed stocks on traditional equity venues.

I already have full programmatic access to the crypto side. I now need to
choose how to access the equity side.

I am a retail trader, I'm not professional or institutional, I don't have a legal entity.

TASK
Give me a comprehensive, opinionated comparison of every viable stock-market
exchange, broker, prime broker, ATS, and third-party service (including
market-data vendors) that I could use to:

1. Pull real-time order book data (Level 1) via API/WebSocket/SDK.
2. Place, modify, and cancel orders programmatically.
3. Achieve best execution at the lowest all-in cost.

EVALUATION DIMENSIONS — address each per option

- API surface: REST, WebSocket, FIX 4.2/4.4, gRPC; official SDKs and
  languages supported.
- Market data: L1, SIP vs direct feeds,
  and the _non-display / algorithmic-use_ licensing cost (this is often
  the hidden killer).
- Trading hours: regular session, pre/post market, and overnight 24x5
  or 24x7 access (e.g., Blue Ocean ATS, 24X National Exchange, IBKR
  Overnight, Robinhood 24-Hour Market). This is critical because RWA
  tokens trade 24/7 and arbitrage often opens _outside_ RTH.
- Fractional shares programmatically (RWA tokens are frequently fractional).
- Short selling: programmatic support, locate/borrow workflow, HTB fees.
- Fees: commissions, SEC/TAF/FINRA fees, exchange take/make, PFOF
  treatment, market-data subscription, FIX/co-lo fees, inactivity fees.
- Account requirements: minimum funding, retail status
  implication, jurisdictions accepted
  (especially non-US residents).

CATEGORIES TO COVER

1. Retail / prosumer brokers with APIs — Interactive Brokers (TWS API,
   IBKR Web/Client Portal API, FIX), Alpaca, TradeStation, Tradier,
   tastytrade, Lightspeed, Schwab (post-TDA), Webull, Moomoo, etc.
2. DMA / sponsored-access providers and routing platforms.
3. Market data vendors usable independently of execution — Polygon.io,
   Databento, IEX Cloud (or successor), Alpaca Data, Intrinio, Nasdaq
   Data Link, Refinitiv, Bloomberg B-PIPE, exchange direct feeds
   (Nasdaq TotalView, NYSE OpenBook, Cboe PITCH).
4. Overnight / 24x5 / 24x7 equity venues and the brokers that route to
   them.
5. Crypto-native or hybrid platforms that also offer the equity leg
   under one roof (e.g., IBKR's crypto, Robinhood, Bakkt, Public,
   anyone else where I could keep both legs at one venue).

OUTPUT FORMAT
For each option produce a structured row:

- Name & one-line description
- Type (broker / data vendor / ATS / exchange)
- API/SDK details
- Order book depth available + algo-use licensing cost
- All-in fee model with concrete numbers where possible
- Extended & overnight hours support
- Fractional shares + short selling support
- Min funding, jurisdictions, entity accounts
- Pros / cons SPECIFICALLY for a crypto-equity RWA arbitrage use case
- Notable gotchas

Then give me a recommended stack for retail $2k–$30k capital.
