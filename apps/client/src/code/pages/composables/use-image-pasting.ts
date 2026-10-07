import { useEventListener } from '@vueuse/core';

export function useImagePasting() {
  useEventListener(
    'paste' as any,
    async (event: ClipboardEvent) => {
      const target = event.target as HTMLElement;

      if (
        target.closest('.ProseMirror') == null ||
        (event.clipboardData?.files?.length ?? 0) === 0
      ) {
        return;
      }

      mainLogger.sub('useImagePasting').info('Perform');

      for (const file of Array.from(event.clipboardData!.files)) {
        if (!file.type.startsWith('image/')) {
          continue;
        }

        // One megabyte, not five.
        //
        // A pasted picture is stored inside the board itself, and the whole
        // board travels in one message every time somebody opens it. Big
        // pictures make that message enormous, and past a point the board
        // stops loading for everybody with no error to explain why.
        if (file.size > 1024 * 1024) {
          $quasar().notify({
            message: 'Pictures have to be under 1MB.',
            color: 'negative',
          });
          continue;
        }

        const reader = new FileReader();

        reader.addEventListener('loadend', (event) => {
          internals.pages.react.page.selection.format((chain) =>
            chain.setImage({
              src: event.target!.result as string,
            }),
          );
        });

        reader.readAsDataURL(file);
      }

      event.preventDefault();
    },
    { capture: true },
  );
}
