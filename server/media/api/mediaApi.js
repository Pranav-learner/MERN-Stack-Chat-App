/**
 * @module media/api/mediaApi
 *
 * Facade wrapping MediaManager methods for HTTP controllers.
 */

export function createMediaApi(mediaManager) {
  return {
    uploadMedia: (params) => mediaManager.uploadMedia(params),
    downloadMedia: (params) => mediaManager.downloadMedia(params),
    getMetadata: (params) => mediaManager.getMetadata(params),
    deleteMedia: (params) => mediaManager.deleteMedia(params),
    cancelUpload: (params) => mediaManager.cancelUpload(params),
    cancelDownload: (params) => mediaManager.cancelDownload(params),
    retryUpload: (params) => mediaManager.retryUpload(params),
    retryDownload: (params) => mediaManager.retryDownload(params),
    listMedia: (params) => mediaManager.listMedia(params),
    verifyMedia: (params) => mediaManager.verifyMedia(params),
    getOperation: (params) => mediaManager.getOperation(params),
    getOperations: (params) => mediaManager.getOperations(params),
    getDiagnostics: (params) => mediaManager.getDiagnostics(params),
    health: () => mediaManager.health(),
  };
}
