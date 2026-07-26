import { ContentCreator, contentCreatorStates } from "#core/contentCreator";
import { entityDisplay } from "./entityDisplay.ts";

export function contentCreatorDisplay(contentCreator: ContentCreator) {
  return entityDisplay(contentCreator, {
    label: "Content Creator Display",
    detail: (cc) => cc.toDetailString(),
    fields: [{
      label: "State",
      getValue: (cc) => cc.state,
      setValue: async (cc, value) => {
        if (!contentCreatorStates.includes(value as any)) {
          console.error(`Invalid state "${value}". Valid states: ${contentCreatorStates.join(", ")}`);
          return;
        }
        await cc.setState(value as typeof contentCreatorStates[number]);
      },
    }],
    extraActions: [{
      label: "Delete",
      run: async () => await contentCreator.delete()
    }]
  });
}
