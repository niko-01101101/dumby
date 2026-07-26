import { ContentCreator } from "#core/contentCreator";
import { entityDisplay } from "./entityDisplay.ts";

export function contentCreatorDisplay(contentCreator: ContentCreator) {
  return entityDisplay(contentCreator, {
    label: "Content Creator Display",
    detail: (cc) => cc.toDetailString(),
    extraActions: [{
      label: "Delete",
      run: async () => await contentCreator.delete()
    }]
  });
}
