// shrinkPhoto(uri): a phone photo made small enough to upload.
//
// A camera original is 3-12 MB (48 MP on newer phones, HEIC on iPhone). Sent
// as-is it takes long enough on a phone connection for the upload to drop, or
// it passes the server's body limit, and the runtime AI reads only PNG, JPEG,
// WebP and GIF. So shrink every photo before it leaves the phone: redrawn to
// at most 1568 px on the long edge (what vision models read anyway) as a JPEG
// at 0.8, usually 200-500 KB, whatever format it was taken in.
//
// Needs expo-image-manipulator, which the starter does not install: add it
// (and expo-image-picker) with the deps action before importing this file.
//
//   import * as ImagePicker from 'expo-image-picker';
//   import { shrinkPhoto } from '../lib/shrink-photo';
//
//   const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
//   if (!picked.canceled) {
//     const photo = await shrinkPhoto(picked.assets[0]); // or a bare uri
//     await api('POST', '/api/photos', { image: photo.dataUrl });
//   }
//
// Pass the picker's asset when you have it: its width and height decide the
// resize up front, so the full-size photo is never rendered on its own. A bare
// uri costs one full-size render to read the size first.
//
// Rejects with a message fit to show the person when the photo cannot be
// opened (a format the web version's browser cannot read, a broken file).
import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';

export const MAX_EDGE = 1568;
const QUALITY = 0.8;

export type PhotoSource = string | { uri: string; width?: number; height?: number };
export type ShrunkPhoto = { uri: string; dataUrl: string; width: number; height: number };

export async function shrinkPhoto(photo: PhotoSource): Promise<ShrunkPhoto> {
  const { uri, width = 0, height = 0 } = typeof photo === 'string' ? { uri: photo } : photo;
  const context = ImageManipulator.manipulate(uri);
  let image: ImageRef;
  try {
    const first = width > 0 && height > 0 ? null : await context.renderAsync();
    const w = first ? first.width : width;
    const h = first ? first.height : height;
    if (Math.max(w, h) > MAX_EDGE) {
      context.resize(w >= h ? { width: MAX_EDGE } : { height: MAX_EDGE });
      image = await context.renderAsync();
    } else {
      image = first ?? (await context.renderAsync());
    }
  } catch {
    throw new Error("This photo can't be opened here. Choose a JPEG or PNG instead.");
  }
  const saved = await image.saveAsync({ compress: QUALITY, format: SaveFormat.JPEG, base64: true });
  return { uri: saved.uri, dataUrl: `data:image/jpeg;base64,${saved.base64}`, width: saved.width, height: saved.height };
}
