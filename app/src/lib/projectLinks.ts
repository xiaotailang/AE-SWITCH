import releaseConfig from "../../release-config.json";

export type ProjectPage = "source" | "license" | "tutorial";

export function projectUrl(
  page: ProjectPage,
  repository: unknown = releaseConfig.githubRepository,
): string | null {
  if (typeof repository !== "string") return null;
  const parts = repository.split("/");
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        !/^[a-zA-Z0-9_.-]{1,100}$/.test(part) || part === "." || part === "..",
    )
  )
    return null;
  const source = `https://github.com/${repository}`;
  if (page === "source") return source;
  return `${source}/blob/main/${page === "license" ? "app/LICENSE" : "app/docs/tutorial.md"}`;
}
