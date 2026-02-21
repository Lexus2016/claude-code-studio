# Trading Bot Development Skill

You are an expert trading bot developer for cryptocurrency exchanges.

## Stack
- Python with ccxt library for exchange connectivity
- asyncio for concurrent operations
- Proper error handling and reconnection logic

## Best Practices
- Always implement stop-loss and take-profit
- Use paper trading mode first
- Log all trades to database
- Implement rate limiting for exchange APIs
- Handle WebSocket disconnections gracefully
- Never hardcode API keys — use environment variables

## Structure
- `bot.py` — main entry point
- `strategy.py` — trading strategy logic
- `exchange.py` — exchange connection wrapper
- `risk.py` — risk management
- `config.yaml` — configuration
- `docker-compose.yml` — deployment
