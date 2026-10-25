/* ============================================================
   MOTOR · FILTROS
   Los streams de un PDF casi siempre vienen codificados. La clave
   /Filter dice cómo: /FlateDecode es zlib (lo mismo que un .zip).
   El navegador ya trae un descompresor: DecompressionStream.
   ============================================================ */

/* Descomprime datos zlib ('deflate'). Es asíncrono: devuelve una promesa. */
async function inflar(bytes) {
  const lector = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream('deflate'))
    .getReader();
  const partes = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await lector.read();
      if (done) break;
      partes.push(value);
      total += value.length;
    }
  } catch (error) {
    // Muchos PDF traen un par de bytes de más después de los datos comprimidos
    // (un salto de línea antes de 'endstream'). El descompresor se queja al final,
    // pero para entonces ya entregó todo: nos quedamos con lo que salió.
    if (total === 0) throw new Error('No se pudo descomprimir el stream.');
  }
  return unirPartes(partes, total);
}

function unirPartes(partes, total) {
  const salida = new Uint8Array(total);
  let posicion = 0;
  for (const parte of partes) {
    salida.set(parte, posicion);
    posicion += parte.length;
  }
  return salida;
}

/* Predictores PNG (/Predictor 10 a 15). Antes de comprimir, cada fila se guardó
   como DIFERENCIA con sus vecinos, porque las diferencias comprimen mejor.
   Cada fila empieza con un byte que dice qué vecino se usó; acá deshacemos eso. */
function deshacerPredictorPng(datos, columnas, colores = 1, bits = 8) {
  const bpp = Math.max(1, Math.ceil(colores * bits / 8));   // bytes por píxel
  const ancho = Math.ceil(columnas * colores * bits / 8);   // bytes por fila (sin el byte de tipo)
  const filas = Math.floor(datos.length / (ancho + 1));
  const salida = new Uint8Array(filas * ancho);

  for (let f = 0; f < filas; f++) {
    const tipo = datos[f * (ancho + 1)];
    const origen = f * (ancho + 1) + 1;
    const destino = f * ancho;
    for (let i = 0; i < ancho; i++) {
      const crudo = datos[origen + i];
      const izquierda = i >= bpp ? salida[destino + i - bpp] : 0;
      const arriba = f > 0 ? salida[destino - ancho + i] : 0;
      const diagonal = (f > 0 && i >= bpp) ? salida[destino - ancho + i - bpp] : 0;
      let valor;
      switch (tipo) {
        case 0: valor = crudo; break;                                  // None
        case 1: valor = crudo + izquierda; break;                      // Sub
        case 2: valor = crudo + arriba; break;                         // Up (el más común en índices)
        case 3: valor = crudo + ((izquierda + arriba) >> 1); break;    // Average
        case 4: valor = crudo + paeth(izquierda, arriba, diagonal); break;
        default: throw new Error('Fila con un predictor PNG desconocido: ' + tipo);
      }
      salida[destino + i] = valor;   // un Uint8Array guarda solo 8 bits: 300 se guarda como 44 (la suma "da la vuelta")
    }
  }
  return salida;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/* ASCII85: cada 5 caracteres imprimibles guardan 4 bytes. Es de la época en que los
   PDF viajaban por canales que solo aceptaban texto; hoy solo agrega un 25 % de peso. */
function deshacerAscii85(datos) {
  const salida = new Uint8Array(Math.ceil(datos.length * 4 / 5) + 4);
  let largo = 0, grupo = 0, cantidad = 0;
  for (let i = 0; i < datos.length; i++) {
    const c = datos[i];
    if (c === 0x7e) break;                          // '~' de la marca de cierre '~>'
    if (c <= 0x20) continue;                        // espacios y saltos de línea se ignoran
    if (c === 0x7a && cantidad === 0) {             // 'z' abrevia cuatro bytes en cero
      largo += 4;
      continue;
    }
    grupo = grupo * 85 + (c - 33);
    if (++cantidad === 5) {
      salida[largo++] = grupo >>> 24;
      salida[largo++] = (grupo >>> 16) & 255;
      salida[largo++] = (grupo >>> 8) & 255;
      salida[largo++] = grupo & 255;
      grupo = 0;
      cantidad = 0;
    }
  }
  if (cantidad > 0) {                                // grupo final incompleto: se rellena con 'u'
    for (let k = cantidad; k < 5; k++) grupo = grupo * 85 + 84;
    const ultimos = [grupo >>> 24, (grupo >>> 16) & 255, (grupo >>> 8) & 255, grupo & 255];
    for (let k = 0; k < cantidad - 1; k++) salida[largo++] = ultimos[k];
  }
  return salida.subarray(0, largo);
}

/* ASCIIHex: cada byte escrito como dos dígitos hexadecimales, "48656c6c6f>". */
function deshacerAsciiHex(datos) {
  const digitos = bytesATexto(datos).replace(/>.*$/s, '').replace(/[^0-9a-fA-F]/g, '');
  const salida = new Uint8Array(Math.ceil(digitos.length / 2));
  for (let i = 0; i < salida.length; i++) {
    salida[i] = parseInt((digitos.substr(i * 2, 2) + '0').slice(0, 2), 16);
  }
  return salida;
}

/* Aplica una cadena de filtros: /Filter [/ASCII85Decode /FlateDecode].
   Se detiene en el primero que no conoce (por ejemplo /DCTDecode, que ya es un JPEG)
   y devuelve los datos junto con los filtros que quedaron pendientes. */
async function decodificar(datos, filtros, parametros = []) {
  for (let i = 0; i < filtros.length; i++) {
    const p = parametros[i] || {};
    switch (filtros[i]) {
      case 'FlateDecode': {
        datos = await inflar(datos);
        const predictor = p.Predictor || 1;
        if (predictor >= 10) {
          datos = deshacerPredictorPng(datos, p.Columns || 1, p.Colors || 1, p.BitsPerComponent || 8);
        } else if (predictor !== 1) {
          throw new Error('Predictor TIFF (2): no soportado.');
        }
        break;
      }
      case 'ASCII85Decode':
        datos = deshacerAscii85(datos);
        break;
      case 'ASCIIHexDecode':
        datos = deshacerAsciiHex(datos);
        break;
      default:
        return { datos, pendientes: filtros.slice(i) };
    }
  }
  return { datos, pendientes: [] };
}
/* ---------- Los bytes de un stream ----------
   12 0 obj << /Length 350 /Filter /FlateDecode >> stream
   ...350 bytes...
   endstream endobj                                                                   */
function datosDeStream(bytes, texto, diccionario) {
  let inicio = texto.indexOf('stream', diccionario.fin) + 'stream'.length;
  if (texto[inicio] === '\r') inicio++;      // después de 'stream' viene \r\n o \n
  if (texto[inicio] === '\n') inicio++;
  let largo = leerNumero(diccionario.dic, 'Length');
  // Si /Length es una referencia (12 0 R) o está mal, medimos hasta 'endstream'.
  if (largo === null || !texto.slice(inicio + largo, inicio + largo + 12).includes('endstream')) {
    largo = texto.indexOf('endstream', inicio) - inicio;
  }
  return bytes.subarray(inicio, inicio + largo);
}

/* ---------- La tabla comprimida (PDF 1.5+) ----------
   El índice es un objeto más: << /Type /XRef /W [1 2 1] /Filter /FlateDecode >> stream.
   Descomprimido, es binario: cada entrada ocupa 1+2+1 bytes (lo que diga /W).
     tipo 0: libre · tipo 1: objeto suelto en un byte · tipo 2: objeto EMPAQUETADO dentro de otro */
async function leerTablaComprimida(bytes, texto, posicion) {
  const cabecera = /\s*\d+\s+\d+\s+obj/y;
  cabecera.lastIndex = posicion;
  if (!cabecera.test(texto)) return null;
  const diccionario = leerDiccionario(texto, cabecera.lastIndex);
  if (!diccionario || leerNombre(diccionario.dic, 'Type') !== 'XRef') return null;

  const { datos } = await decodificar(
    datosDeStream(bytes, texto, diccionario),
    leerFiltros(diccionario.dic),
    leerParametros(diccionario.dic)
  );
  const anchos = leerArray(diccionario.dic, 'W');
  const indice = leerArray(diccionario.dic, 'Index') || [0, leerNumero(diccionario.dic, 'Size')];

  const entradas = new Map();
  let q = 0;
  for (let k = 0; k < indice.length; k += 2) {
    for (let n = indice[k]; n < indice[k] + indice[k + 1]; n++) {
      const campos = anchos.map(cantidadBytes => {
        if (cantidadBytes === 0) return null;
        let valor = 0;
        // Cada campo es un número "big-endian": el primer byte es el más significativo.
        // Usamos *256 y no << 8 porque en JS los operadores de bits trabajan con 32 bits con signo.
        for (let b = 0; b < cantidadBytes; b++) valor = valor * 256 + datos[q++];
        return valor;
      });
      // Un ancho de cero significa que el campo no está escrito y vale su valor por omisión:
      // tipo 1 para el primero, cero para los otros dos. Usamos ?? y no ||: con || un tipo 0 (libre) valdría 1.
      const tipo = campos[0] ?? 1, segundo = campos[1] ?? 0, tercero = campos[2] ?? 0;
      if (tipo === 1) entradas.set(n, { tipo: 1, posicion: segundo, generacion: tercero });
      else if (tipo === 2) entradas.set(n, { tipo: 2, contenedor: segundo, lugar: tercero });
      else entradas.set(n, { tipo: 0 });
    }
  }
  return { tipo: 'comprimida', posicion, entradas, trailer: diccionario.dic };
}
/* ---------- Describir un objeto suelto ---------- */
function describirObjeto(bytes, texto, posicion) {
  const cabecera = /\s*\d+\s+\d+\s+obj\s*/y;
  cabecera.lastIndex = posicion;
  cabecera.exec(texto);
  const inicio = cabecera.lastIndex;

  const diccionario = texto.startsWith('<<', inicio) ? leerDiccionario(texto, inicio) : null;
  const esStream = diccionario !== null && /^\s*stream/.test(texto.slice(diccionario.fin, diccionario.fin + 20));
  const desdeFin = esStream ? texto.indexOf('endstream', diccionario.fin) : inicio;
  const fin = texto.indexOf('endobj', desdeFin);

  let vista = diccionario ? diccionario.dic : texto.slice(inicio, fin === -1 ? inicio + 200 : fin).trim();
  if (esStream) vista += '\nstream\n… (datos binarios) …\nendstream';
  const dic = diccionario ? diccionario.dic : '';
  return {
    tamano: fin === -1 ? null : fin + 'endobj'.length - posicion,
    tipo: leerNombre(dic, 'Type') || (esStream ? '(stream)' : '—'),
    categoria: clasificar(dic, esStream),
    vista: vista.length > 3000 ? vista.slice(0, 3000) + ' …' : vista,
    esStream,
    diccionario
  };
}

/* Categorías para el gráfico "De qué está hecho el peso". */
function clasificar(dic, esStream) {
  if (!esStream) return 'Diccionarios y estructura';
  const tipo = leerNombre(dic, 'Type'), subtipo = leerNombre(dic, 'Subtype');
  if (subtipo === 'Image') return leerFiltros(dic).includes('DCTDecode') ? 'Imágenes JPEG' : 'Imágenes sin pérdida';
  if (tipo === 'Metadata') return 'Metadatos';
  if (/\/Length[123]\b/.test(dic) || ['Type1C', 'CIDFontType0C', 'OpenType'].includes(subtipo)) return 'Tipografías';
  if (subtipo === 'Form') return 'Dibujos vectoriales';
  if (tipo === 'XRef' || tipo === 'ObjStm') return 'Diccionarios y estructura';
  return 'Contenido de las páginas y otros';
}

/* ---------- Listar todos los objetos ----------
   Los sueltos (tipo 1) se describen yendo a su posición. Los empaquetados (tipo 2)
   viven dentro de un stream /Type /ObjStm: hay que descomprimirlo y ubicarlos. */
async function listarObjetos(bytes, texto, entradas) {
  const objetos = [];
  for (const [numero, e] of entradas) {
    if (e.tipo !== 1) continue;
    const info = describirObjeto(bytes, texto, e.posicion);
    objetos.push({ numero, generacion: e.generacion, donde: `byte ${e.posicion.toLocaleString('es-AR')}`, ...info });
  }

  for (const contenedor of objetos.filter(o => o.tipo === 'ObjStm')) {
    const dic = contenedor.diccionario.dic;
    let datos;
    try {
      ({ datos } = await decodificar(datosDeStream(bytes, texto, contenedor.diccionario), leerFiltros(dic), leerParametros(dic)));
    } catch {
      continue;                                   // si no se puede abrir, lo salteamos
    }
    const contenido = bytesATexto(datos);
    const primero = leerNumero(dic, 'First');     // dónde termina la cabecera "num pos num pos ..."
    const cantidad = leerNumero(dic, 'N');
    const pares = contenido.slice(0, primero).trim().split(/\s+/).map(Number);
    for (let k = 0; k < cantidad; k++) {
      const numero = pares[2 * k], desde = pares[2 * k + 1];
      const hasta = k + 1 < cantidad ? pares[2 * k + 3] : contenido.length - primero;
      // Si el índice dice que la versión vigente del objeto está en otro lado, no lo contamos.
      const entrada = entradas.get(numero);
      if (entrada && !(entrada.tipo === 2 && entrada.contenedor === contenedor.numero)) continue;
      const cuerpo = contenido.slice(primero + desde, primero + hasta).trim();
      objetos.push({
        numero, generacion: 0,
        donde: `dentro del objeto ${contenedor.numero}`,
        tamano: null,                             // su peso ya está contado en el contenedor
        tipo: leerNombre(cuerpo, 'Type') || '—',
        categoria: 'Diccionarios y estructura (empaquetado)',
        vista: cuerpo.length > 3000 ? cuerpo.slice(0, 3000) + ' …' : cuerpo
      });
    }
  }
  return objetos.sort((a, b) => a.numero - b.numero);
}