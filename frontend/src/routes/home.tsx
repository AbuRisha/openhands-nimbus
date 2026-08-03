import React from "react";
import { PrefetchPageLinks } from "react-router";
import { HomeHeader } from "#/components/features/home/home-header/home-header";
import { RepoConnector } from "#/components/features/home/repo-connector";
import { TaskSuggestions } from "#/components/features/home/tasks/task-suggestions";
import { GitRepository } from "#/types/git";
import { NewConversation } from "#/components/features/home/new-conversation/new-conversation";
import { RecentConversations } from "#/components/features/home/recent-conversations/recent-conversations";
import { HomepageCTA } from "#/components/features/home/homepage-cta";
import { isCTADismissed } from "#/utils/local-storage";
import { useAppMode } from "#/hooks/use-app-mode";

<PrefetchPageLinks page="/conversations/:conversationId" />;

function HomeScreen() {
  const { isEnterpriseCloud } = useAppMode();
  const [selectedRepo, setSelectedRepo] = React.useState<GitRepository | null>(
    null,
  );

  const [shouldShowCTA, setShouldShowCTA] = React.useState(
    () => !isCTADismissed("homepage"),
  );

  return (
    <div
      data-testid="home-screen"
      className="px-0 pt-4 bg-transparent h-full flex flex-col pt-[35px] overflow-y-auto rounded-xl lg:px-[42px] lg:pt-[42px] custom-scrollbar-always"
    >
      {/*
        Lead with the customer's WORK, not with onboarding.

        This screen used to open on two marketing cards — "Open Repository /
        connect your GitHub, GitLab, Bitbucket or Azure DevOps account" beside
        "Start from Scratch" — with the actual conversations pushed below them,
        so every visit opened by asking a returning user to connect an account
        they had already declined.

        The pairs are kept EXACTLY as upstream had them, including the
        `md:flex-row` two-column class strings. An earlier attempt here split
        them into one-child rows while leaving `min-w-full` in place; a
        min-width:100% flex child inside a centred, max-width parent overflows
        its container, which threw the whole screen out of alignment and
        squeezed the suggestions column to one word per line. The ordering was
        never the problem, so only the ordering changes.
      */}
      <HomeHeader />

      <div className="pt-[25px] flex justify-center">
        <div
          className="flex flex-col gap-5 px-6 sm:max-w-full sm:min-w-full md:flex-row lg:px-0 lg:max-w-[703px] lg:min-w-[703px]"
          data-testid="home-screen-new-conversation-section"
        >
          <NewConversation />
          <RecentConversations />
        </div>
      </div>

      <div className="pt-4 flex sm:justify-start md:justify-center">
        <div
          className="flex flex-col gap-5 px-6 md:flex-row min-w-full md:max-w-full lg:px-0 lg:max-w-[703px] lg:min-w-[703px]"
          data-testid="home-screen-recent-conversations-section"
        >
          <RepoConnector onRepoSelection={(repo) => setSelectedRepo(repo)} />
          <TaskSuggestions filterFor={selectedRepo} />
        </div>
      </div>

      {isEnterpriseCloud && shouldShowCTA && (
        <div className="fixed bottom-4 right-8 z-50 md:bottom-6 md:right-12">
          <HomepageCTA setShouldShowCTA={setShouldShowCTA} />
        </div>
      )}
    </div>
  );
}

export default HomeScreen;
