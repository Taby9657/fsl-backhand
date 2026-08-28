-- Obnova zapomenutého hesla přes jednorázový kód poslaný e-mailem.
--
-- Kód se ukládá jako bcrypt hash, takže ani z databáze ho nikdo nepřečte.
-- Platnost je krátká a počet pokusů omezený.

CREATE TABLE "PasswordReset" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "codeHash"  TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt"    TIMESTAMP(3),
    "attempts"  INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PasswordReset_userId_expiresAt_idx"
  ON "PasswordReset"("userId", "expiresAt");
