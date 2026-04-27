# Supabase V2

Usa `supabase-reorganizacion-v2.sql` como archivo unico de referencia.

## Que hace
- Elimina por completo la estructura anterior.
- Crea las tablas nuevas con nombres en MAYUSCULAS.
- No crea columnas `id`, `created_at` ni `updated_at`.
- Crea vistas limpias con prefijo `VW_`.
- Mantiene `SACA` fuera del esquema.

## Por que las vistas llevan `VW_`
PostgreSQL no permite que una tabla y una vista tengan exactamente el mismo nombre.
Por eso:
- tabla: `INVENTARIO`
- vista: `VW_INVENTARIO`

## Importante
Este cambio es solo de estructura.
La logica del backend actual sigue apuntando al esquema viejo, asi que no debes ejecutar este SQL en produccion hasta que reorganicemos el codigo para trabajar con estas tablas nuevas.
