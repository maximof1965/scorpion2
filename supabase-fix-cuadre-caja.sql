-- =============================================================
--  FIX CUADRE CAJA
-- -------------------------------------------------------------
--  La columna "CUADRE CAJA" estaba SUMANDO "CONTRATOS" cuando
--  deberia RESTARLO (porque CONTRATOS es egreso del operador).
--
--  Formula correcta:
--    CUADRE CAJA = BASE + RETIRO + GUARDA + BAR + VENTAS
--                  - CONTRATOS - GASTOS
--
--  Como es una GENERATED ALWAYS AS ... STORED, hay que
--  eliminarla y volver a crearla. Postgres recalcula los
--  valores existentes automaticamente.
--
--  Las vistas que la referencian se recrean despues.
-- =============================================================

BEGIN;

-- 1) Borrar las vistas que dependen de la columna
DROP VIEW IF EXISTS public."VW_CAJA" CASCADE;

-- 2) Eliminar la columna calculada con la formula incorrecta
ALTER TABLE public."CAJA" DROP COLUMN IF EXISTS "CUADRE CAJA";

-- 3) Recrearla con la formula correcta
ALTER TABLE public."CAJA"
  ADD COLUMN "CUADRE CAJA" BIGINT GENERATED ALWAYS AS (
    COALESCE("BASE",0) + COALESCE("RETIRO",0) + COALESCE("GUARDA",0) +
    COALESCE("BAR",0)  + COALESCE("VENTAS",0)
    - COALESCE("CONTRATOS",0) - COALESCE("GASTOS",0)
  ) STORED;

-- 4) Recrear la vista VW_CAJA con el mismo orden de columnas
CREATE VIEW public."VW_CAJA" AS
SELECT
  "FECHA","TURNO","BASE","RETIRO","GUARDA","BAR","CONTRATOS",
  "GASTOS","VENTAS","CUADRE CAJA"
FROM public."CAJA";

COMMIT;

-- =============================================================
--  VERIFICACION (opcional)
--  Despues de correr este script, valida con:
--    SELECT "FECHA","TURNO","BASE","RETIRO","GUARDA","BAR",
--           "CONTRATOS","GASTOS","VENTAS","CUADRE CAJA"
--    FROM public."CAJA"
--    ORDER BY "FECHA" DESC, "TURNO";
-- =============================================================
