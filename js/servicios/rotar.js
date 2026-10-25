// 1) En js/catalogo.js, una entrada más dentro de HERRAMIENTAS:
{
  id: 'rotar',
  titulo: 'Rotar PDF',
  descripcion: 'Gira todas las páginas del documento.',
  icono: '⟳',
  multiples: false,
  minimo: 1,
  boton: 'Rotar PDF',
  opciones: [
    {
      tipo: 'eleccion',
      nombre: 'angulo',
      etiqueta: 'Ángulo',
      valores: [
        { valor: '90', etiqueta: '90° a la derecha', elegido: true },
        { valor: '180', etiqueta: '180°' },
        { valor: '270', etiqueta: '90° a la izquierda' }
      ]
    }
  ]
},

// 2) js/servicios/rotar.js  (y su <script> en index.html, antes de interfaz.js)
SERVICIOS.rotar = async function (archivos, opciones, avisar) {
  const archivo = archivos[0];
  const doc = await abrirPdf(archivo.bytes);
  const angulo = Number(opciones.angulo);

  avisar('Rotando páginas…');
  for (const pagina of doc.getPages()) {
    const actual = pagina.getRotation().angle;          // puede venir rotada de antes
    pagina.setRotation(PDFLib.degrees((actual + angulo) % 360));
  }

  const bytes = await doc.save({ useObjectStreams: true });
  return {
    tipo: 'descargas',
    mensaje: `Se rotaron ${doc.getPageCount()} páginas ${angulo}°.`,
    archivos: [{ nombre: nombreSinExtension(archivo.nombre) + '-rotado.pdf', bytes }]
  };
};