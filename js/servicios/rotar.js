/* ============================================================
   SERVICIO · ROTAR
   Gira todas las páginas del documento según el ángulo elegido.
   ============================================================ */
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