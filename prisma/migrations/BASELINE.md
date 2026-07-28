# Baseline existující Railway DB pro Prisma Migrate

Databáze byla původně vytvořena přes `prisma db push`. Před přechodem na `prisma migrate deploy`
je nutné označit initial migration jako již aplikovanou (jednou, lokálně):

```bash
cd ~/Claude/Projects/FSL/backend

# 1. Nastav DATABASE_URL na Railway production DB (z Railway dashboardu)
export DATABASE_URL="postgresql://..."

# 2. Označ init migraci jako aplikovanou (DB ji přeskočí, jen zaregistruje v _prisma_migrations)
npx prisma migrate resolve --applied "20250101000000_init"

# 3. Ověř
npx prisma migrate status
```

Po tomto kroku Railway `prisma migrate deploy` bude fungovat správně — init přeskočí,
nové migrace aplikuje.

## Přidání nové migrace (příště)

```bash
# Uprav schema.prisma → pak:
npx prisma migrate dev --name popis_zmeny
# → vytvoří soubor v migrations/, commitni a pushni
```
