import is from '@sindresorhus/is';
import { RenovateConfig } from '../../config/types';
import { SELF_HOSTED_DASHBOARD_URL_UNAVAILABLE } from '../../constants/error-messages';
import { logger } from '../../logger';
import { EnsureIssueConfig, EnsureIssueResult, Issue } from '../../platform';
import { Http } from '../../util/http';
import { sanitize } from '../../util/sanitize';

type SelfHostIssue = {
  iid: number;
  title: string;
};

let repository: string;
let http: Http;
let issueListCache: Array<SelfHostIssue> = [];
let renovateConfig: RenovateConfig;

const init = (config: RenovateConfig): void => {
  if (!config.dependencyDashboardUrl) {
    throw new Error(SELF_HOSTED_DASHBOARD_URL_UNAVAILABLE);
  }
  if (!config.repository) {
    throw Error('Repository is null');
  }
  repository = config.repository;
  http = new Http('self-host', {
    baseUrl: config.dependencyDashboardUrl,
  });
  renovateConfig = config;
};

const getIssueList = async (): Promise<SelfHostIssue[]> => {
  const res = await http.getJson<Array<SelfHostIssue>>(`${repository}/issues`, {
    baseUrl: renovateConfig.dependencyDashboardUrl,
  });
  if (!is.array(res.body)) {
    logger.warn({ responseBody: res.body }, 'Could not retrieve issue list');
    return [];
  }
  issueListCache = res.body.map((i) => ({
    iid: i.iid,
    title: i.title,
  }));
  return issueListCache;
};

const ensureIssue = async ({
  title,
  reuseTitle,
  body,
}: EnsureIssueConfig): Promise<EnsureIssueResult | null> => {
  logger.debug(`ensureIssue()`);
  const description = sanitize(body);
  try {
    const issueList = await getIssueList();
    let issue = issueList.find((i) => i.title === title);
    if (!issue) {
      issue = issueList.find((i) => i.title === reuseTitle);
    }
    if (issue) {
      const existingDescription = (
        await http.getJson<{ description: string }>(
          `/${repository}/issues/${issue.iid}`,
          {
            baseUrl: renovateConfig.dependencyDashboardUrl,
          }
        )
      ).body.description;
      if (issue.title !== title || existingDescription !== description) {
        logger.debug('Updating issue');
        await http.putJson(`${repository}/issues/${issue.iid}`, {
          body: { title, description },
          baseUrl: renovateConfig.dependencyDashboardUrl,
        });
        return 'updated';
      }
    } else {
      await http.postJson(`/${repository}/issues`, {
        baseUrl: renovateConfig.dependencyDashboardUrl,
        body: {
          title,
          description,
        },
      });
      logger.info('Issue created');
      return 'created';
    }
  } catch (err) /* istanbul ignore next */ {
    if (err.message.startsWith('Issues are disabled for this repo')) {
      logger.debug(`Could not create issue: ${(err as Error).message}`);
    } else {
      logger.warn({ err }, 'Could not ensure issue');
    }
  }
  return null;
};

const ensureIssueClosing = async (title: string): Promise<void> => {
  logger.debug(`ensureIssueClosing()`);
  const issueList = await getIssueList();
  for (const issue of issueList) {
    if (issue.title === title) {
      logger.debug({ issue }, 'Closing issue');
      await http.putJson(`${repository}/issues/${issue.iid}`, {
        body: { state_event: 'close' },
        baseUrl: renovateConfig.dependencyDashboardUrl,
      });
    }
  }
};

export async function getIssue(
  number: number,
  useCache = true
): Promise<Issue | null> {
  try {
    const issueBody = (
      await http.getJson<{ description: string }>(
        `${repository}/issues/${number}`,
        {
          useCache,
          baseUrl: renovateConfig.dependencyDashboardUrl,
        }
      )
    ).body.description;
    return {
      number,
      body: issueBody,
    };
  } catch (err) /* istanbul ignore next */ {
    logger.warn({ err, number }, 'Error getting issue');
    return null;
  }
}

const findIssue = async (title: string): Promise<Issue> => {
  logger.debug(`findIssue(${title})`);
  try {
    const issueList = await getIssueList();
    const issue = issueList.find((i) => i.title === title);
    if (!issue) {
      return null;
    }
    return await getIssue(issue.iid);
  } catch (err) /* istanbul ignore next */ {
    logger.warn('Error finding issue');
    return null;
  }
};

export { init, ensureIssue, ensureIssueClosing, findIssue };
