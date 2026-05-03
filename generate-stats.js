#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const USERNAME = process.env.PROFILE_USERNAME ||
  (process.env.GITHUB_REPOSITORY ? process.env.GITHUB_REPOSITORY.split('/')[0] : 'balanikaran')
const CACHE_FILE = path.join(__dirname, 'stats-cache.json')
const CONFIG_FILE = path.join(__dirname, 'profile-config.json')
const CACHE_VERSION = 1

const LANGUAGE_COLORS = {
  Astro: 'ff5d01',
  CSS: '563d7c',
  Dart: '00b4ab',
  Dockerfile: '384d54',
  Go: '00add8',
  HTML: 'e34c26',
  Java: 'b07219',
  JavaScript: 'f1e05a',
  Kotlin: 'a97bff',
  Python: '3572a5',
  Rust: 'dea584',
  Shell: '89e051',
  TypeScript: '3178c6',
  Vue: '41b883',
  Default: '555555'
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US')
}

function yearsSince(dateString) {
  const createdAt = new Date(dateString)
  const now = new Date()
  const years = now.getFullYear() - createdAt.getFullYear()
  return Math.max(years, 0)
}

function languageColor(language) {
  const raw = LANGUAGE_COLORS[language] || LANGUAGE_COLORS.Default
  return raw.replace('#', '')
}

function badge(label, message, color, logo) {
  const params = new URLSearchParams({
    style: 'flat',
    label,
    message,
    color
  })

  if (logo) {
    params.set('logo', logo)
    params.set('logoColor', 'white')
  }

  return `![${message}](https://img.shields.io/static/v1?${params.toString()})`
}

function additionsBadge(value) {
  const amount = Number(value || 0)
  return badge('', amount > 0 ? `+${formatNumber(amount)}` : '0', 'brightgreen')
}

function deletionsBadge(value) {
  const amount = Number(value || 0)
  return badge('', amount > 0 ? `-${formatNumber(amount)}` : '0', 'red')
}

function languageBadge(language) {
  return badge('', `${language.name} ${language.percentage}%`, languageColor(language.name))
}

function repoCacheKey(repo) {
  const identity = repo.id || repo.nameWithOwner
  return crypto.createHash('sha256').update(identity).digest('hex')
}

function emptyCache() {
  return {
    version: CACHE_VERSION,
    username: USERNAME,
    generatedAt: null,
    lastYear: null,
    contributionYears: {},
    repos: {},
    orgs: {}
  }
}

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return emptyCache()

  try {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    return {
      ...emptyCache(),
      ...cache,
      contributionYears: cache.contributionYears || {},
      repos: cache.repos || {},
      orgs: cache.orgs || {}
    }
  } catch (error) {
    console.warn('Could not read stats-cache.json. Starting with an empty cache.')
    return emptyCache()
  }
}

function writeCache(cache) {
  fs.writeFileSync(CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`)
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {
      activeProjectIgnore: [],
      trackedOrganizations: [],
      featuredOrg: null
    }
  }

  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
}

async function getToken() {
  if (process.env.USER_API_TOKEN) return process.env.USER_API_TOKEN
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  return null
}

async function graphql(token, query, variables = {}) {
  if (!token) {
    return graphqlWithGh(query, variables)
  }

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-readme-generator'
    },
    body: JSON.stringify({ query, variables })
  })

  const body = await response.json()

  if (!response.ok || body.errors) {
    const details = body.errors ? JSON.stringify(body.errors) : response.statusText
    throw new Error(`GitHub GraphQL request failed: ${details}`)
  }

  return body.data
}

function graphqlWithGh(query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`]

  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) continue
    args.push('-f', `${key}=${value}`)
  }

  try {
    const output = execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const body = JSON.parse(output)

    if (body.errors) {
      throw new Error(JSON.stringify(body.errors))
    }

    return body.data
  } catch (error) {
    throw new Error(`GitHub GraphQL request failed through gh: ${error.message}`)
  }
}

async function fetchUser(token, from, to) {
  const query = `
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        id
        login
        name
        createdAt
        repositories(ownerAffiliations: OWNER, first: 1) {
          totalCount
        }
        allYears: contributionsCollection {
          contributionYears
        }
        lastYear: contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalPullRequestReviewContributions
          restrictedContributionsCount
        }
      }
    }
  `

  const data = await graphql(token, query, { login: USERNAME, from, to })
  if (!data.user) throw new Error(`GitHub user not found: ${USERNAME}`)
  return data.user
}

async function fetchYearlyContributions(token, year) {
  const query = `
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalPullRequestReviewContributions
          restrictedContributionsCount
        }
      }
    }
  `

  const data = await graphql(token, query, {
    login: USERNAME,
    from: `${year}-01-01T00:00:00Z`,
    to: `${year}-12-31T23:59:59Z`
  })

  return data.user.contributionsCollection
}

async function fetchOrganization(token, login) {
  const query = `
    query($login: String!) {
      organization(login: $login) {
        id
        login
        name
        url
      }
    }
  `

  const data = await graphql(token, query, { login })
  return data.organization
}

async function fetchOrganizationContributions(token, orgId, from, to) {
  const query = `
    query($login: String!, $org: ID!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(organizationID: $org, from: $from, to: $to) {
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalPullRequestReviewContributions
          restrictedContributionsCount
        }
      }
    }
  `

  const data = await graphql(token, query, {
    login: USERNAME,
    org: orgId,
    from,
    to
  })

  return data.user.contributionsCollection
}

async function fetchOrganizationYearlyContributions(token, orgId, year) {
  return fetchOrganizationContributions(
    token,
    orgId,
    `${year}-01-01T00:00:00Z`,
    `${year}-12-31T23:59:59Z`
  )
}

async function fetchOwnedRepos(token, userId, since) {
  const repos = []
  let cursor = null
  let hasNextPage = true

  while (hasNextPage) {
    const query = `
      query($login: String!, $cursor: String, $userId: ID!, $since: GitTimestamp!) {
        user(login: $login) {
          repositories(first: 50, after: $cursor, ownerAffiliations: OWNER) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              ...RepoFields
            }
          }
        }
      }

      fragment RepoFields on Repository {
        id
        name
        nameWithOwner
        url
        isPrivate
        stargazerCount
        owner {
          login
        }
        defaultBranchRef {
          target {
            ... on Commit {
              history(since: $since, author: {id: $userId}) {
                totalCount
              }
            }
          }
        }
        languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
          edges {
            size
            node {
              name
            }
          }
        }
      }
    `

    const data = await graphql(token, query, {
      login: USERNAME,
      cursor,
      userId,
      since
    })

    const page = data.user.repositories
    repos.push(...page.nodes)
    hasNextPage = page.pageInfo.hasNextPage
    cursor = page.pageInfo.endCursor
  }

  return repos
}

async function fetchContributedRepos(token, userId, since) {
  const repos = []
  let cursor = null
  let hasNextPage = true

  while (hasNextPage) {
    const query = `
      query($login: String!, $cursor: String, $userId: ID!, $since: GitTimestamp!) {
        user(login: $login) {
          repositoriesContributedTo(
            first: 50
            after: $cursor
            includeUserRepositories: true
            contributionTypes: [COMMIT, ISSUE, PULL_REQUEST]
          ) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              ...RepoFields
            }
          }
        }
      }

      fragment RepoFields on Repository {
        id
        name
        nameWithOwner
        url
        isPrivate
        stargazerCount
        owner {
          login
        }
        defaultBranchRef {
          target {
            ... on Commit {
              history(since: $since, author: {id: $userId}) {
                totalCount
              }
            }
          }
        }
        languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
          edges {
            size
            node {
              name
            }
          }
        }
      }
    `

    const data = await graphql(token, query, {
      login: USERNAME,
      cursor,
      userId,
      since
    })

    const page = data.user.repositoriesContributedTo
    repos.push(...page.nodes)
    hasNextPage = page.pageInfo.hasNextPage
    cursor = page.pageInfo.endCursor
  }

  return repos
}

async function fetchRepoLineStats(token, repo, userId, since) {
  let additions = 0
  let deletions = 0
  let cursor = null
  let hasNextPage = true

  while (hasNextPage) {
    const query = `
      query($owner: String!, $repo: String!, $cursor: String, $userId: ID!, $since: GitTimestamp!) {
        repository(owner: $owner, name: $repo) {
          defaultBranchRef {
            target {
              ... on Commit {
                history(first: 100, after: $cursor, since: $since, author: {id: $userId}) {
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                  nodes {
                    additions
                    deletions
                  }
                }
              }
            }
          }
        }
      }
    `

    const data = await graphql(token, query, {
      owner: repo.ownerLogin,
      repo: repo.name,
      cursor,
      userId,
      since
    })

    const history = data.repository?.defaultBranchRef?.target?.history
    if (!history) break

    for (const commit of history.nodes) {
      additions += commit.additions || 0
      deletions += commit.deletions || 0
    }

    hasNextPage = history.pageInfo.hasNextPage
    cursor = history.pageInfo.endCursor
  }

  return { additions, deletions }
}

function repoLanguages(repo) {
  const totalSize = repo.languages.edges.reduce((sum, edge) => sum + edge.size, 0)
  if (totalSize === 0) return []

  return repo.languages.edges.map(edge => ({
    name: edge.node.name,
    percentage: edge.size / totalSize
  }))
}

function normalizeRepo(repo) {
  return {
    key: repoCacheKey(repo),
    name: repo.name,
    nameWithOwner: repo.nameWithOwner,
    ownerLogin: repo.owner.login,
    url: repo.url,
    isPrivate: repo.isPrivate,
    stars: repo.isPrivate ? 0 : repo.stargazerCount,
    commits: repo.defaultBranchRef?.target?.history?.totalCount || 0,
    additions: 0,
    deletions: 0,
    languages: repoLanguages(repo)
  }
}

function mergeCurrentRepos(...repoLists) {
  const reposByKey = new Map()

  for (const repo of repoLists.flat()) {
    const normalized = normalizeRepo(repo)
    const existing = reposByKey.get(normalized.key)

    if (!existing || normalized.commits > existing.commits) {
      reposByKey.set(normalized.key, normalized)
    }
  }

  return [...reposByKey.values()]
}

function cacheRepo(repo, nowIso, since) {
  const cached = {
    visibility: repo.isPrivate ? 'private' : 'public',
    lastSeenAt: nowIso,
    lastWindow: {
      from: since,
      to: nowIso
    },
    stats: {
      commitsLastYear: repo.commits,
      additionsLastYear: repo.additions,
      deletionsLastYear: repo.deletions,
      stars: repo.stars
    },
    languages: repo.languages.map(language => ({
      name: language.name,
      percentage: Number(language.percentage.toFixed(6))
    }))
  }

  if (!repo.isPrivate) {
    cached.name = repo.name
    cached.nameWithOwner = repo.nameWithOwner
    cached.ownerLogin = repo.ownerLogin
    cached.url = repo.url
  }

  return cached
}

function cachedRepoToStats(repo) {
  return {
    name: repo.name || null,
    nameWithOwner: repo.nameWithOwner || null,
    ownerLogin: repo.ownerLogin || null,
    url: repo.url || null,
    isPrivate: repo.visibility !== 'public',
    stars: repo.stats?.stars || 0,
    commits: repo.stats?.commitsLastYear || 0,
    additions: repo.stats?.additionsLastYear || 0,
    deletions: repo.stats?.deletionsLastYear || 0,
    languages: repo.languages || []
  }
}

function mergeContributionYears(cache, yearlyByYear, nowIso) {
  const contributionYears = { ...(cache.contributionYears || {}) }

  for (const [year, current] of Object.entries(yearlyByYear)) {
    const previous = contributionYears[year] || {}
    contributionYears[year] = {
      commits: Math.max(previous.commits || 0, current.commits || 0),
      issues: Math.max(previous.issues || 0, current.issues || 0),
      prs: Math.max(previous.prs || 0, current.prs || 0),
      reviews: Math.max(previous.reviews || 0, current.reviews || 0),
      restricted: Math.max(previous.restricted || 0, current.restricted || 0),
      lastSeenAt: nowIso
    }
  }

  return contributionYears
}

function mergeLastYear(cache, current, activeRepos, nowIso, since) {
  const previous = cache.lastYear || {}
  const repoCommits = activeRepos.reduce((sum, repo) => sum + repo.commits, 0)

  return {
    from: since,
    to: nowIso,
    commits: Math.max(previous.commits || 0, current.commits || 0, repoCommits),
    issues: Math.max(previous.issues || 0, current.issues || 0),
    prs: Math.max(previous.prs || 0, current.prs || 0),
    reviews: Math.max(previous.reviews || 0, current.reviews || 0),
    restricted: Math.max(previous.restricted || 0, current.restricted || 0),
    lastSeenAt: nowIso
  }
}

function updateCache(cache, currentRepos, yearlyByYear, lastYear, orgSnapshots, nowIso, since) {
  const repos = { ...(cache.repos || {}) }

  for (const repo of currentRepos) {
    repos[repo.key] = cacheRepo(repo, nowIso, since)
  }

  const cachedRepos = Object.values(repos).map(cachedRepoToStats)
  const activeRepos = cachedRepos.filter(repo => repo.commits > 0)
  const orgs = mergeOrgSummaries(cache, orgSnapshots, nowIso)

  return {
    version: CACHE_VERSION,
    username: USERNAME,
    generatedAt: nowIso,
    lastYear: mergeLastYear(cache, lastYear, activeRepos, nowIso, since),
    contributionYears: mergeContributionYears(cache, yearlyByYear, nowIso),
    orgs,
    repos,
    summary: {
      knownRepos: Object.keys(repos).length,
      privateOrRestrictedRepos: cachedRepos.filter(repo => repo.isPrivate).length,
      publicRepos: cachedRepos.filter(repo => !repo.isPrivate).length,
      trackedOrgs: Object.keys(orgs).length
    }
  }
}

function sumContributionYears(contributionYears) {
  return Object.values(contributionYears).reduce((acc, year) => {
    acc.commits += year.commits || 0
    acc.issues += year.issues || 0
    acc.prs += year.prs || 0
    acc.reviews += year.reviews || 0
    acc.restricted += year.restricted || 0
    return acc
  }, { commits: 0, issues: 0, prs: 0, reviews: 0, restricted: 0 })
}

function normalizeContributionCollection(collection) {
  return {
    commits: collection.totalCommitContributions || 0,
    issues: collection.totalIssueContributions || 0,
    prs: collection.totalPullRequestContributions || 0,
    reviews: collection.totalPullRequestReviewContributions || 0,
    restricted: collection.restrictedContributionsCount || 0
  }
}

function buildOrgRepoStats(repos) {
  const reposByOwner = new Map()

  for (const repo of repos) {
    if (!repo.ownerLogin || repo.ownerLogin === USERNAME) continue
    const ownerRepos = reposByOwner.get(repo.ownerLogin) || []
    ownerRepos.push(repo)
    reposByOwner.set(repo.ownerLogin, ownerRepos)
  }

  return new Map([...reposByOwner.entries()].map(([login, ownerRepos]) => [
    login,
    {
      repoCount: ownerRepos.length,
      publicRepos: ownerRepos.filter(repo => !repo.isPrivate).length,
      privateRepos: ownerRepos.filter(repo => repo.isPrivate).length,
      commitsLastYear: ownerRepos.reduce((sum, repo) => sum + repo.commits, 0),
      additionsLastYear: ownerRepos.reduce((sum, repo) => sum + repo.additions, 0),
      deletionsLastYear: ownerRepos.reduce((sum, repo) => sum + repo.deletions, 0),
      languages: topLanguages(ownerRepos.filter(repo => repo.commits > 0), 3)
    }
  ]))
}

function mergeOrgYears(previousYears = {}, currentYears = {}, nowIso) {
  const years = { ...previousYears }

  for (const [year, current] of Object.entries(currentYears)) {
    const previous = years[year] || {}
    years[year] = {
      commits: Math.max(previous.commits || 0, current.commits || 0),
      issues: Math.max(previous.issues || 0, current.issues || 0),
      prs: Math.max(previous.prs || 0, current.prs || 0),
      reviews: Math.max(previous.reviews || 0, current.reviews || 0),
      restricted: Math.max(previous.restricted || 0, current.restricted || 0),
      lastSeenAt: nowIso
    }
  }

  return years
}

function mergeOrgSummary(previous = {}, snapshot, nowIso) {
  const previousRepoStats = previous.repoStats || {}
  const currentRepoStats = snapshot.repoStats || {}

  return {
    login: snapshot.login,
    name: snapshot.name || previous.name || snapshot.login,
    url: snapshot.url || previous.url || `https://github.com/${snapshot.login}`,
    lastSeenAt: nowIso,
    lastYear: {
      commits: Math.max(previous.lastYear?.commits || 0, snapshot.lastYear?.commits || 0),
      issues: Math.max(previous.lastYear?.issues || 0, snapshot.lastYear?.issues || 0),
      prs: Math.max(previous.lastYear?.prs || 0, snapshot.lastYear?.prs || 0),
      reviews: Math.max(previous.lastYear?.reviews || 0, snapshot.lastYear?.reviews || 0),
      restricted: Math.max(previous.lastYear?.restricted || 0, snapshot.lastYear?.restricted || 0)
    },
    years: mergeOrgYears(previous.years, snapshot.years, nowIso),
    repoStats: {
      repoCount: Math.max(previousRepoStats.repoCount || 0, currentRepoStats.repoCount || 0),
      publicRepos: Math.max(previousRepoStats.publicRepos || 0, currentRepoStats.publicRepos || 0),
      privateRepos: Math.max(previousRepoStats.privateRepos || 0, currentRepoStats.privateRepos || 0),
      commitsLastYear: Math.max(previousRepoStats.commitsLastYear || 0, currentRepoStats.commitsLastYear || 0),
      additionsLastYear: Math.max(previousRepoStats.additionsLastYear || 0, currentRepoStats.additionsLastYear || 0),
      deletionsLastYear: Math.max(previousRepoStats.deletionsLastYear || 0, currentRepoStats.deletionsLastYear || 0)
    },
    languages: snapshot.languages?.length ? snapshot.languages : previous.languages || []
  }
}

function mergeOrgSummaries(cache, orgSnapshots, nowIso) {
  const orgs = { ...(cache.orgs || {}) }

  for (const snapshot of orgSnapshots) {
    orgs[snapshot.login] = mergeOrgSummary(orgs[snapshot.login], snapshot, nowIso)
  }

  return orgs
}

function topLanguages(repos, topN = 5) {
  const weighted = new Map()

  for (const repo of repos) {
    const commits = repo.commits || 0
    for (const language of repo.languages) {
      const current = weighted.get(language.name) || 0
      weighted.set(language.name, current + commits * language.percentage)
    }
  }

  const top = [...weighted.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)

  const total = top.reduce((sum, [, value]) => sum + value, 0)
  return top.map(([name, value]) => ({
    name,
    percentage: total > 0 ? Math.round((value / total) * 100) : 0
  }))
}

function buildStatsRows(data) {
  const allTimeRows = [
    `🔥 **${formatNumber(data.totalCommitsAllTime)}** commits`,
    `📋 **${formatNumber(data.totalIssuesAllTime)}** issues`,
    `🔀 **${formatNumber(data.totalPRsAllTime)}** PRs`,
    `👀 **${formatNumber(data.totalReviewsAllTime)}** PR reviews`,
    `🔒 **${formatNumber(data.totalRestrictedAllTime)}** private/restricted contributions`,
    `📦 **${formatNumber(data.knownRepos)}** known repos`,
    `⭐ **${formatNumber(data.stars)}** owned public stars`
  ]

  const lastYearRows = [
    `🔥 **${formatNumber(data.totalCommitsLastYear)}** commits`,
    `📋 **${formatNumber(data.totalIssuesLastYear)}** issues`,
    `🔀 **${formatNumber(data.totalPRsLastYear)}** PRs`,
    `👀 **${formatNumber(data.totalReviewsLastYear)}** PR reviews`,
    `🔒 **${formatNumber(data.totalRestrictedLastYear)}** private/restricted contributions`,
    `${additionsBadge(data.totalAdditionsLastYear)} lines added`,
    `${deletionsBadge(data.totalDeletionsLastYear)} lines removed`
  ]

  const languageRows = data.topLanguages.map(languageBadge)

  return allTimeRows.map((allTime, index) => {
    return `| ${allTime} | ${lastYearRows[index]} | ${languageRows[index] || ''} |`
  }).join('\n')
}

function inlineLanguageBadges(languages) {
  return languages.length > 0
    ? languages.map(languageBadge).join(' ')
    : ''
}

function buildOrgRows(orgs) {
  if (orgs.length === 0) {
    return '| No tracked org activity yet | - | - | - | - |'
  }

  return orgs.map(org => {
    const lines = `${additionsBadge(org.repoStats.additionsLastYear)} ${deletionsBadge(org.repoStats.deletionsLastYear)}`
    const repoCounts = `${formatNumber(org.repoStats.repoCount)} repos (${formatNumber(org.repoStats.publicRepos)} public, ${formatNumber(org.repoStats.privateRepos)} private)`
    const activity = `🔥 **${formatNumber(org.lastYear.commits)}** commits · 🔀 **${formatNumber(org.lastYear.prs)}** PRs · 👀 **${formatNumber(org.lastYear.reviews)}** reviews`
    return `| [${org.name}](${org.url}) | ${repoCounts} | ${activity} | ${lines} | ${inlineLanguageBadges(org.languages)} |`
  }).join('\n')
}

function buildFeaturedOrgSection(featuredOrg, cachedOrg) {
  if (!featuredOrg || !cachedOrg) return ''

  const repoStats = cachedOrg.repoStats || {}
  const lastYear = cachedOrg.lastYear || {}
  const orgName = featuredOrg.name || cachedOrg.name || cachedOrg.login
  const githubUrl = featuredOrg.github || cachedOrg.url
  const websiteUrl = featuredOrg.website
  const description = featuredOrg.description || 'A project I am currently building.'
  const lines = `${additionsBadge(repoStats.additionsLastYear)} ${deletionsBadge(repoStats.deletionsLastYear)}`
  const links = [
    `[Website](${websiteUrl})`,
    `[GitHub](${githubUrl})`
  ].filter(link => !link.includes('(undefined)')).join(' · ')

  return `## 🏠 Current Weekend Project: ${orgName}

${description}

${links}

| Repos | Last Year Activity | Lines | Top languages |
|-------|--------------------|-------|---------------|
| 📦 **${formatNumber(repoStats.repoCount)}** tracked repos | 🔥 **${formatNumber(lastYear.commits)}** commits · 🔀 **${formatNumber(lastYear.prs)}** PRs | ${lines} | ${inlineLanguageBadges(cachedOrg.languages || [])} |`
}

async function buildTrackedOrgSnapshots(token, config, years, since, nowIso, currentRepos) {
  const trackedLogins = new Set(config.trackedOrganizations || [])
  if (config.featuredOrg?.login) trackedLogins.add(config.featuredOrg.login)

  const orgRepoStats = buildOrgRepoStats(currentRepos)
  const snapshots = []

  for (const login of trackedLogins) {
    let org = null
    try {
      org = await fetchOrganization(token, login)
    } catch (error) {
      console.warn(`Skipping organization metadata for ${login}.`)
    }

    const repoStats = orgRepoStats.get(login) || {
      repoCount: 0,
      publicRepos: 0,
      privateRepos: 0,
      commitsLastYear: 0,
      additionsLastYear: 0,
      deletionsLastYear: 0,
      languages: []
    }

    const yearsByYear = {}
    let lastYear = {
      commits: repoStats.commitsLastYear,
      issues: 0,
      prs: 0,
      reviews: 0,
      restricted: 0
    }

    if (org?.id) {
      try {
        const lastYearCollection = await fetchOrganizationContributions(token, org.id, since, nowIso)
        lastYear = {
          ...normalizeContributionCollection(lastYearCollection),
          commits: Math.max(lastYearCollection.totalCommitContributions || 0, repoStats.commitsLastYear)
        }

        for (const year of years) {
          const collection = await fetchOrganizationYearlyContributions(token, org.id, year)
          yearsByYear[year] = normalizeContributionCollection(collection)
        }
      } catch (error) {
        console.warn(`Skipping organization contribution totals for ${login}.`)
      }
    }

    if (
      repoStats.repoCount > 0 ||
      lastYear.commits > 0 ||
      lastYear.issues > 0 ||
      lastYear.prs > 0 ||
      lastYear.reviews > 0 ||
      lastYear.restricted > 0
    ) {
      snapshots.push({
        login,
        name: config.featuredOrg?.login === login ? config.featuredOrg.name : org?.name || login,
        url: org?.url || (config.featuredOrg?.login === login ? config.featuredOrg.github : null) || `https://github.com/${login}`,
        lastYear,
        years: yearsByYear,
        repoStats,
        languages: repoStats.languages
      })
    }
  }

  return snapshots
}

function renderTemplate(template, data) {
  let result = template
    .replace(/{{\s*NAME\s*}}/g, data.name)
    .replace(/{{\s*USERNAME\s*}}/g, data.username)
    .replace(/{{\s*ACCOUNT_AGE\s*}}/g, String(data.accountAge))
    .replace(/{{\s*STATS_ROWS\s*}}/g, data.statsRows)
    .replace(/{{\s*ORG_ROWS\s*}}/g, data.orgRows)
    .replace(/{{\s*FEATURED_ORG_SECTION\s*}}/g, data.featuredOrgSection)

  const repoBlock = result.match(/{{\s*REPO_TEMPLATE_START\s*}}([\s\S]*?){{\s*REPO_TEMPLATE_END\s*}}/)
  if (!repoBlock) return result

  const repoTemplate = repoBlock[1].trim()
  const repos = data.topRepos.length > 0
    ? data.topRepos.map(repo => repoTemplate
      .replace(/{{\s*REPO_NAME\s*}}/g, repo.nameWithOwner)
      .replace(/{{\s*REPO_URL\s*}}/g, repo.url)
      .replace(/{{\s*REPO_COMMITS\s*}}/g, formatNumber(repo.commits))
      .replace(/{{\s*REPO_ADDITIONS\s*}}/g, additionsBadge(repo.additions))
      .replace(/{{\s*REPO_DELETIONS\s*}}/g, deletionsBadge(repo.deletions))
    ).join('\n')
    : '- No public repo activity found in the last year.'

  return result.replace(/{{\s*REPO_TEMPLATE_START\s*}}[\s\S]*?{{\s*REPO_TEMPLATE_END\s*}}/, repos)
}

async function main() {
  const config = loadConfig()
  const token = await getToken()
  const now = new Date()
  const nowIso = now.toISOString()
  const sinceDate = new Date(now)
  sinceDate.setFullYear(sinceDate.getFullYear() - 1)
  const since = sinceDate.toISOString()

  const user = await fetchUser(token, since, nowIso)
  const years = user.allYears.contributionYears
  const yearlyCollections = await Promise.all(years.map(year => fetchYearlyContributions(token, year)))
  const yearlyByYear = Object.fromEntries(years.map((year, index) => [
    year,
    {
      commits: yearlyCollections[index].totalCommitContributions,
      issues: yearlyCollections[index].totalIssueContributions,
      prs: yearlyCollections[index].totalPullRequestContributions,
      reviews: yearlyCollections[index].totalPullRequestReviewContributions,
      restricted: yearlyCollections[index].restrictedContributionsCount
    }
  ]))

  const ownedRepos = await fetchOwnedRepos(token, user.id, since)
  const contributedRepos = await fetchContributedRepos(token, user.id, since)
  const currentRepos = mergeCurrentRepos(ownedRepos, contributedRepos)
  const currentActiveRepos = currentRepos
    .filter(repo => repo.commits > 0)
    .sort((a, b) => b.commits - a.commits)

  for (const repo of currentActiveRepos) {
    try {
      const lineStats = await fetchRepoLineStats(token, repo, user.id, since)
      repo.additions = lineStats.additions
      repo.deletions = lineStats.deletions
    } catch (error) {
      const label = repo.isPrivate ? 'a private or restricted repo' : repo.nameWithOwner
      console.warn(`Skipping line stats for ${label}.`)
    }
  }

  const orgSnapshots = await buildTrackedOrgSnapshots(
    token,
    config,
    years,
    since,
    nowIso,
    currentRepos
  )

  const cache = updateCache(
    loadCache(),
    currentRepos,
    yearlyByYear,
    {
      commits: user.lastYear.totalCommitContributions,
      issues: user.lastYear.totalIssueContributions,
      prs: user.lastYear.totalPullRequestContributions,
      reviews: user.lastYear.totalPullRequestReviewContributions,
      restricted: user.lastYear.restrictedContributionsCount
    },
    orgSnapshots,
    nowIso,
    since
  )
  writeCache(cache)

  const cachedRepos = Object.values(cache.repos).map(cachedRepoToStats)
  const knownActiveRepos = cachedRepos.filter(repo => repo.commits > 0)
  const totals = sumContributionYears(cache.contributionYears)
  const activeProjectIgnore = new Set(config.activeProjectIgnore || [])
  const publicTopRepos = currentActiveRepos
    .filter(repo => !repo.isPrivate)
    .filter(repo => !activeProjectIgnore.has(repo.nameWithOwner))
    .slice(0, 10)
  const orgsForReadme = Object.values(cache.orgs || {})
    .filter(org => {
      const repoStats = org.repoStats || {}
      const lastYear = org.lastYear || {}
      return repoStats.repoCount > 0 || lastYear.commits > 0 || lastYear.prs > 0 || lastYear.reviews > 0 || lastYear.restricted > 0
    })
    .sort((a, b) => {
      const aScore = (a.lastYear?.commits || 0) + (a.lastYear?.prs || 0) * 3 + (a.lastYear?.reviews || 0)
      const bScore = (b.lastYear?.commits || 0) + (b.lastYear?.prs || 0) * 3 + (b.lastYear?.reviews || 0)
      return bScore - aScore
    })

  const data = {
    name: user.name || user.login,
    username: user.login,
    accountAge: yearsSince(user.createdAt),
    knownRepos: cache.summary.knownRepos,
    totalCommitsAllTime: totals.commits,
    totalIssuesAllTime: totals.issues,
    totalPRsAllTime: totals.prs,
    totalReviewsAllTime: totals.reviews,
    totalRestrictedAllTime: totals.restricted,
    totalCommitsLastYear: cache.lastYear.commits,
    totalIssuesLastYear: cache.lastYear.issues,
    totalPRsLastYear: cache.lastYear.prs,
    totalReviewsLastYear: cache.lastYear.reviews,
    totalRestrictedLastYear: cache.lastYear.restricted,
    totalAdditionsLastYear: knownActiveRepos.reduce((sum, repo) => sum + repo.additions, 0),
    totalDeletionsLastYear: knownActiveRepos.reduce((sum, repo) => sum + repo.deletions, 0),
    stars: cachedRepos
      .filter(repo => !repo.isPrivate && repo.ownerLogin === USERNAME)
      .reduce((sum, repo) => sum + repo.stars, 0),
    topLanguages: topLanguages(knownActiveRepos),
    topRepos: publicTopRepos,
    orgRows: buildOrgRows(orgsForReadme),
    featuredOrgSection: buildFeaturedOrgSection(
      config.featuredOrg,
      config.featuredOrg?.login ? cache.orgs?.[config.featuredOrg.login] : null
    )
  }

  data.statsRows = buildStatsRows(data)

  const template = fs.readFileSync(path.join(__dirname, 'TEMPLATE.md'), 'utf8')
  const readme = renderTemplate(template, data)
  fs.writeFileSync(path.join(__dirname, 'README.md'), readme)
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
