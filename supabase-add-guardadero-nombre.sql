-- =============================================================
-- AGREGAR COLUMNA "NOMBRE" A GUARDADERO (despues de "VALOR" en la vista)
-- Conserva los datos existentes.
-- =============================================================

BEGIN;

DROP VIEW IF EXISTS public."VW_GUARDADERO" CASCADE;

ALTER TABLE public."GUARDADERO" ADD COLUMN IF NOT EXISTS "NOMBRE" TEXT;

UPDATE public."GUARDADERO" SET "NOMBRE" = '' WHERE "NOMBRE" IS NULL;

ALTER TABLE public."GUARDADERO" ALTER COLUMN "NOMBRE" SET DEFAULT '';
ALTER TABLE public."GUARDADERO" ALTER COLUMN "NOMBRE" SET NOT NULL;

CREATE VIEW public."VW_GUARDADERO" AS
SELECT "MARCA TEMPORAL", "VALOR", "NOMBRE"
FROM public."GUARDADERO";

COMMIT;
