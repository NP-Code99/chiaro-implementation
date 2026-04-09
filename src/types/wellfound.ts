// Raw response shape from Apify radeance~wellfound-job-listings-scraper
// Field names and types verified against live API response 2026-04-08

export interface WellfoundCompany {
  data_type: string
  slug: string
  name: string
  type: string | null
  category: string[]
  stage: string[] | null
  location: string | null
  locations: string[] | null
  size: string | null
  is_hiring: boolean | null
  open_job_posts: number | null
  open_job_roles: string[] | null
  no_outside_funding: boolean | null
  total_funding_rounds: number | null
  funding_rounds: unknown[] | null
  // Note: API has inconsistent spelling ("totaly" not "totally")
  totaly_raised: number | null
  totaly_raised_formatted: string | null
  totally_raised_currency: string | null
  investors: unknown[] | null
  founders: unknown[] | null
  board_members: unknown[] | null
  incubators: unknown[] | null
  is_incubator: boolean | null
  team_members: unknown[] | null
  badges: string[]
  profile_url: string
  url: string | null
  logo_url: string | null
  email: string | null
  blog_url: string | null
  twitter_url: string | null
  linkedin_url: string | null
  facebook_url: string | null
  productHunt_url: string | null
}

export interface WellfoundJob {
  data_type: string
  job_id: string
  job_auto_posted: boolean
  job_reposted: boolean
  job_listing_posted: string | null
  job_published: string | null
  job_title: string
  job_location: string[]
  job_details: string[]
  job_type: string | null
  job_compensation: string | null
  job_equity: string | null
  job_min_equity: number | null
  job_max_equity: number | null
  job_pay_range: string | null
  job_min_pay: string | null
  job_max_pay: string | null
  job_min_salary: number | null
  job_max_salary: number | null
  job_salary_currency: string | null
  job_salary_unit: string | null
  job_remote: boolean
  job_remote_possible: string | null
  job_description: string
  job_application_url: string | null
  job_url: string
  job_listing_valid_until: string | null
  job_benefits: string | null
  direct_application: boolean
  skills: string[] | null
  job_experience: string | null
  required_experience_years: number | null
  required_experience_months: number | null
  // Note: API returns a string ("Not Available", "Available") not a boolean
  visa_sponsorship: string | null
  job_location_requirement: string | null
  remote_work_policy: string | null
  hires_remotely: boolean
  hires_remotely_in: string[] | null
  relocation: string | null
  hiring_contact: string | null
  hiring_contact_role: string | null
  hiring_contact_experience: string | null
  hiring_contact_location: string | null
  collaboration_hours: string | null
  preferred_timezones: string[] | null
  company: WellfoundCompany
}

export interface FetchWellfoundParams {
  searchQuery?: string
  location?: string
  remote?: boolean
  maxResults?: number
}
