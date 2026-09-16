.PHONY: check up down logs

check:
	./scripts/check-compat.sh

up:
	./scripts/up.sh

down:
	docker compose -f docker-compose.yml down -v

logs:
	docker compose -f docker-compose.yml logs -f --tail=200
