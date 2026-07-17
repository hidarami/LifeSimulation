// imageUpload.js — avatar image upload and camera flash easter egg
import S from './gameState.js';
import { saveImage, loadAllImages } from './state.js';
import { renderAll } from './uiCore.js';
import { openNpcModal } from './uiCore.js';

export async function _resizeImage(dataUrl, maxPx = 300) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(maxPx / img.width, maxPx / img.height, 1);
      const c = document.createElement('canvas');
      c.width  = Math.round(img.width  * ratio);
      c.height = Math.round(img.height * ratio);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export async function loadImageCache() {
  S._imageCache = await loadAllImages().catch(() => ({}));
}

export function initImageUpload() {
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  document.getElementById('btn-avatar-upload').addEventListener('click', e => {
    e.stopPropagation(); S._imgUploadTarget = 'player'; fileInput.click();
  });

  document.addEventListener('click', e => {
    if (e.target.closest('#npc-detail-avatar[data-upload]')) {
      S._imgUploadTarget = e.target.closest('#npc-detail-avatar[data-upload]').dataset.upload;
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file || !S.WS) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      const resized = await _resizeImage(ev.target.result, 300);
      S._imageCache[S._imgUploadTarget] = resized;
      await saveImage(S._imgUploadTarget, resized);
      renderAll();
      if (S._imgUploadTarget !== 'player' && document.getElementById('modal-npc').classList.contains('open')) {
        openNpcModal(S._imgUploadTarget);
      }
    };
    reader.readAsDataURL(file); e.target.value = '';
  });
}

export function showCameraFlash() {
  const el = document.createElement('div'); el.className = 'camera-flash-overlay';
  document.body.appendChild(el); setTimeout(() => el.remove(), 900);
}