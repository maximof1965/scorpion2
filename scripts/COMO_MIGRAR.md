# Migrar INVENTARIO de Sheets a Supabase

Guia rapida para una sola corrida.

## 1) Descargar el CSV desde Sheets

1. Abre tu Google Sheet del inventario real.
2. Asegurate de estar en la pestana correcta (la del INVENTARIO).
3. Menu: **Archivo -> Descargar -> Valores separados por comas (.csv)**.
4. Guarda el archivo en la carpeta `SCORPIONPRO/` con nombre `inventario.csv`.

## 2) Configurar credenciales

1. Copia `scripts/.env.example` como `scripts/.env`
2. Abre `scripts/.env` y rellena con tus datos reales:
   - **SUPABASE_URL**: en Supabase -> Project Settings -> API -> Project URL
   - **SUPABASE_SERVICE_KEY**: en Supabase -> Project Settings -> API -> `service_role` (secret)

> El archivo `.env` esta en `.gitignore`, NUNCA se sube a GitHub.

## 3) Probar primero (sin tocar la base de datos)

Desde la carpeta `SCORPIONPRO/` en la terminal:

```
node scripts/importar_inventario.js inventario.csv --dry-run
```

Esto te dira:
- Que columnas detecto del CSV y a cuales de Supabase las mapeo
- Cuantas filas son validas
- Cuantas tienen errores y de que tipo
- Un ejemplo de la primera fila ya transformada

Si ves errores, corrige el CSV (o ajustamos el mapeo de headers) y vuelve a probar.

## 4) Carga real

Como tu tabla esta practicamente vacia y los pocos datos no importan,
usa el modo TRUNCAR (vacia primero, luego carga limpio):

```
node scripts/importar_inventario.js inventario.csv --truncar
```

Te va a pedir escribir `BORRAR` para confirmar antes de tocar nada.

Despues empieza a insertar en lotes de 500 y al final te muestra:
- Total insertadas
- Errores (si los hay, te genera `errores_importacion.csv`)

## 5) Verificar

- Abre la app -> seccion **TABLAS** -> elige `INVENTARIO`.
- O en Supabase -> Table Editor -> INVENTARIO.

Listo.

---

## Otras opciones del script

```
--dry-run            Solo valida, no inserta
--modo=skip          (default) Omite filas con NUMERO ya existente
--modo=upsert        Si el NUMERO ya existe, lo ACTUALIZA
--modo=insert        Insert puro (falla si hay duplicados)
--truncar            Vacia INVENTARIO antes de cargar (con confirmacion)
--lote=500           Tamano de lote (1..1000)
--sep=;              Forzar separador (default auto-detecta)
```

## Headers que reconoce automaticamente

El script acepta variaciones comunes para cada columna:

| Supabase | Headers aceptados en el CSV |
|---|---|
| NUMERO | NUMERO, NUMBER, NRO, N, #, NUM |
| FECHA | FECHA, MARCA TEMPORAL, TIMESTAMP, FECHA INGRESO |
| OPER | OPER, OPERADOR, TURNO |
| VR PR | VR PR, VRPR, PRESTAMO, PR |
| VR RT | VR RT, VRRT, RT |
| NOMBRE | NOMBRE, CLIENTE, NAME |
| CC | CC, CEDULA, IDENTIFICACION, DOCUMENTO |
| ART | ART, ARTICULO, TIPO |
| DESCRIPCION | DESCRIPCION, DESC, DETALLE ART |
| LLEVAR | LLEVAR |
| VR IN | VR IN, VRIN, INTERES, IN |
| TOT IN | TOT IN, TOTIN, TOTAL INTERES |
| FECHA INT | FECHA INT, FECHA INTERES |
| VR AB | VR AB, VRAB, ABONO, AB |
| FECHA ABON | FECHA ABON, FECHA ABONO |
| ESPERA | ESPERA |
| RETIROS | RETIROS, RETIRO |
| FECHA RETIRO | FECHA RETIRO, FECHARETIRO |
| DES | DES, DESCUENTO |
| AUMENTO | AUMENTO, AUM |
| FECHA AU | FECHA AU, FECHA AUMENTO |
| TOTAL | TOTAL, TOT |
| UTIL | UTIL, UTILIDAD |

Las columnas que el CSV traiga y que NO esten en esta lista se ignoran (no rompen nada).

## Limpiezas automaticas que hace

- **Numeros**: quita `$`, espacios, separadores de miles. Reconoce `1.234.567,89` (ES) y `1,234,567.89` (EN). Redondea a entero.
- **Fechas**: acepta `DD/MM/YYYY`, `D/M/YY`, `YYYY-MM-DD`, con o sin hora. Convierte a `YYYY-MM-DDTHH:MM:SSZ`.
- **Textos**: quita espacios sobrantes y los pasa a MAYUSCULAS.
- **Vacios**: cualquier celda vacia o `-` o `N/A` se manda como NULL.
