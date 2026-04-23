# Requirements Document

## Introduction

This document specifies the requirements for integrating AWS Cognito SSO authentication with Azure AD SAML into a React TypeScript application. The system will enable users to authenticate through Azure AD using SAML federation via AWS Cognito, retrieve user roles from a backend API, and maintain authenticated sessions using OAuth 2.0 authorization code flow with token-based authentication.

## Glossary

- **Frontend_Application**: The React TypeScript single-page application that provides the user interface
- **Cognito_Service**: AWS Cognito user pool service that manages authentication and token issuance
- **Azure_AD**: Azure Active Directory SAML identity provider federated with Cognito
- **Backend_API**: REST API service that validates tokens and retrieves user data from DynamoDB
- **Auth_Manager**: Frontend component responsible for managing authentication state and token lifecycle
- **Token_Store**: Browser localStorage mechanism for persisting authentication tokens
- **ID_Token**: JWT token containing user identity claims issued by Cognito
- **Access_Token**: OAuth 2.0 access token issued by Cognito
- **Refresh_Token**: Long-lived token used to obtain new ID and access tokens
- **Authorization_Code**: Temporary code returned by Cognito after successful authentication
- **Protected_Route**: React component that restricts access to authenticated users only
- **Hosted_UI**: Cognito-provided authentication interface that handles SAML federation

## Requirements

### Requirement 1: User Authentication Initiation

**User Story:** As a user, I want to click a sign-in button that redirects me to the authentication page, so that I can authenticate with my Azure AD credentials.

#### Acceptance Criteria

1. WHEN a user clicks the sign-in button, THE Frontend_Application SHALL redirect to the Hosted_UI with client_id parameter "d39crquvfb260vrjvs46ghnhi"
2. WHEN redirecting to the Hosted_UI, THE Frontend_Application SHALL include redirect_uri parameter "http://localhost:5173/callback"
3. WHEN redirecting to the Hosted_UI, THE Frontend_Application SHALL include scope parameter "openid email"
4. WHEN redirecting to the Hosted_UI, THE Frontend_Application SHALL include response_type parameter "code"
5. THE Frontend_Application SHALL construct the Hosted_UI URL using domain "us-east-1dn95gfiev.auth.us-east-1.amazoncognito.com"

### Requirement 2: Authorization Code Reception

**User Story:** As a user, I want the application to handle the authentication callback, so that my authentication can be completed seamlessly.

#### Acceptance Criteria

1. WHEN Cognito_Service redirects to "/callback" with an authorization code, THE Frontend_Application SHALL extract the code from the URL query parameters
2. IF the callback URL contains an error parameter, THEN THE Frontend_Application SHALL display the error message to the user
3. WHEN an authorization code is received, THE Frontend_Application SHALL exchange it for tokens within 10 seconds

### Requirement 3: Token Exchange

**User Story:** As a user, I want my authorization code to be exchanged for authentication tokens, so that I can access the application.

#### Acceptance Criteria

1. WHEN the Frontend_Application receives an authorization code, THE Auth_Manager SHALL send a POST request to "https://us-east-1dn95gfiev.auth.us-east-1.amazoncognito.com/oauth2/token"
2. WHEN exchanging the authorization code, THE Auth_Manager SHALL include grant_type parameter "authorization_code"
3. WHEN exchanging the authorization code, THE Auth_Manager SHALL include the client_id parameter "d39crquvfb260vrjvs46ghnhi"
4. WHEN exchanging the authorization code, THE Auth_Manager SHALL include the redirect_uri parameter "http://localhost:5173/callback"
5. WHEN the token exchange succeeds, THE Cognito_Service SHALL return an ID_Token, Access_Token, and Refresh_Token
6. IF the token exchange fails after 3 retry attempts with 1 second delay, THEN THE Auth_Manager SHALL display an error message to the user

### Requirement 4: Token Persistence

**User Story:** As a user, I want my authentication tokens to be saved, so that I remain logged in across page refreshes.

#### Acceptance Criteria

1. WHEN tokens are received from Cognito_Service, THE Auth_Manager SHALL store the ID_Token in Token_Store with key "idToken"
2. WHEN tokens are received from Cognito_Service, THE Auth_Manager SHALL store the Access_Token in Token_Store with key "accessToken"
3. WHEN tokens are received from Cognito_Service, THE Auth_Manager SHALL store the Refresh_Token in Token_Store with key "refreshToken"
4. WHEN storing tokens, THE Auth_Manager SHALL calculate and store the expiration timestamp as current time plus 3600 seconds
5. WHEN storing the expiration timestamp, THE Auth_Manager SHALL use key "tokenExpiration" in Token_Store

### Requirement 5: Backend User Validation

**User Story:** As a user, I want my identity to be validated with the backend system, so that my role and permissions can be retrieved.

#### Acceptance Criteria

1. WHEN tokens are stored successfully, THE Auth_Manager SHALL send a POST request to "https://c92kmsf2ag.execute-api.us-east-1.amazonaws.com/dev/ssologin"
2. WHEN calling the ssologin endpoint, THE Auth_Manager SHALL include the ID_Token in the Authorization header with format "Bearer {token}"
3. WHEN the ssologin request succeeds, THE Backend_API SHALL return a JSON object containing email, name, and role fields
4. IF the ssologin request fails, THEN THE Auth_Manager SHALL retry up to 3 times with 1 second delay between attempts
5. IF the ssologin request fails after all retries, THEN THE Auth_Manager SHALL clear all tokens and redirect to the login page
6. THE Auth_Manager SHALL set a timeout of 30 seconds for the ssologin request

### Requirement 6: User Data Persistence

**User Story:** As a user, I want my profile information to be saved locally, so that the application can display my name and role.

#### Acceptance Criteria

1. WHEN the Backend_API returns user data, THE Auth_Manager SHALL store the email in Token_Store with key "userEmail"
2. WHEN the Backend_API returns user data, THE Auth_Manager SHALL store the name in Token_Store with key "userName"
3. WHEN the Backend_API returns user data, THE Auth_Manager SHALL store the role in Token_Store with key "userRole"

### Requirement 7: Post-Authentication Navigation

**User Story:** As a user, I want to be redirected to the home page after successful authentication, so that I can start using the application.

#### Acceptance Criteria

1. WHEN user data is stored successfully in Token_Store, THE Frontend_Application SHALL redirect to "/home"
2. IF the user was attempting to access a protected route before authentication, THEN THE Frontend_Application SHALL redirect to that original route instead of "/home"

### Requirement 8: Token Validation

**User Story:** As a user, I want my authentication status to be checked automatically, so that I am not prompted to log in unnecessarily.

#### Acceptance Criteria

1. WHEN the Frontend_Application loads, THE Auth_Manager SHALL check if an ID_Token exists in Token_Store
2. WHEN an ID_Token exists, THE Auth_Manager SHALL retrieve the tokenExpiration value from Token_Store
3. WHEN checking token validity, THE Auth_Manager SHALL compare the tokenExpiration timestamp with the current time
4. IF the current time is greater than tokenExpiration, THEN THE Auth_Manager SHALL clear all tokens from Token_Store
5. IF the current time is less than tokenExpiration, THEN THE Auth_Manager SHALL consider the user authenticated

### Requirement 9: Protected Route Access Control

**User Story:** As a user, I want to be redirected to login when accessing protected pages without authentication, so that unauthorized access is prevented.

#### Acceptance Criteria

1. WHEN a user navigates to a protected route, THE Protected_Route SHALL check if a valid ID_Token exists in Token_Store
2. IF no valid ID_Token exists, THEN THE Protected_Route SHALL redirect to "/login"
3. IF a valid ID_Token exists, THEN THE Protected_Route SHALL render the requested page component
4. WHEN redirecting to login, THE Protected_Route SHALL store the attempted route for post-authentication redirect

### Requirement 10: User Interface Display

**User Story:** As a user, I want to see my name and role displayed in the application, so that I can confirm my identity and permissions.

#### Acceptance Criteria

1. WHEN the home page loads for an authenticated user, THE Frontend_Application SHALL retrieve userName from Token_Store and display it in the navigation bar
2. WHEN the home page loads for an authenticated user, THE Frontend_Application SHALL retrieve userRole from Token_Store and display it as a color-coded badge
3. WHEN the home page loads for an authenticated user, THE Frontend_Application SHALL decode the ID_Token and display its claims on the home page
4. WHERE the userRole is "admin", THE Frontend_Application SHALL display the role badge with a red background
5. WHERE the userRole is "user", THE Frontend_Application SHALL display the role badge with a blue background
6. WHERE the userRole is "viewer", THE Frontend_Application SHALL display the role badge with a green background

### Requirement 11: User Logout

**User Story:** As a user, I want to log out of the application, so that my session is terminated and my tokens are invalidated.

#### Acceptance Criteria

1. WHEN a user clicks the logout button, THE Auth_Manager SHALL send a POST request to "https://c92kmsf2ag.execute-api.us-east-1.amazonaws.com/dev/ssologout"
2. WHEN calling the ssologout endpoint, THE Auth_Manager SHALL include the ID_Token in the Authorization header with format "Bearer {token}"
3. WHEN the ssologout request completes, THE Auth_Manager SHALL remove all items from Token_Store
4. WHEN tokens are cleared, THE Frontend_Application SHALL redirect to "/login"
5. IF the ssologout request fails, THEN THE Auth_Manager SHALL still clear tokens and redirect to "/login"
6. THE Auth_Manager SHALL set a timeout of 30 seconds for the ssologout request

### Requirement 12: Silent SSO

**User Story:** As a user, I want to be automatically signed in if I have an active Cognito session, so that I don't need to re-authenticate unnecessarily.

#### Acceptance Criteria

1. WHEN a user navigates to the login page, THE Auth_Manager SHALL check if a valid ID_Token exists in Token_Store
2. IF a valid ID_Token exists in Token_Store, THEN THE Frontend_Application SHALL redirect to "/home" without displaying the login page
3. WHEN checking for silent SSO, THE Auth_Manager SHALL verify the token has not expired by comparing tokenExpiration with current time

### Requirement 13: Error Handling

**User Story:** As a user, I want to see clear error messages when authentication fails, so that I understand what went wrong.

#### Acceptance Criteria

1. IF the token exchange fails with a network error, THEN THE Frontend_Application SHALL display "Unable to connect to authentication service. Please try again."
2. IF the Backend_API returns a 401 status code, THEN THE Frontend_Application SHALL display "Authentication failed. Please sign in again."
3. IF the Backend_API returns a 403 status code, THEN THE Frontend_Application SHALL display "Access denied. You do not have permission to access this application."
4. IF the Backend_API returns a 500 status code, THEN THE Frontend_Application SHALL display "Server error. Please try again later."
5. WHEN displaying an error message, THE Frontend_Application SHALL provide a button to return to the login page

### Requirement 14: Token Refresh

**User Story:** As a user, I want my session to be extended automatically when my tokens expire, so that I don't get logged out while actively using the application.

#### Acceptance Criteria

1. WHEN the Auth_Manager detects a token will expire within 5 minutes, THE Auth_Manager SHALL send a POST request to "https://us-east-1dn95gfiev.auth.us-east-1.amazoncognito.com/oauth2/token" with grant_type "refresh_token"
2. WHEN refreshing tokens, THE Auth_Manager SHALL include the Refresh_Token from Token_Store
3. WHEN refreshing tokens, THE Auth_Manager SHALL include the client_id parameter "d39crquvfb260vrjvs46ghnhi"
4. WHEN the token refresh succeeds, THE Auth_Manager SHALL update the ID_Token and Access_Token in Token_Store
5. WHEN the token refresh succeeds, THE Auth_Manager SHALL update the tokenExpiration timestamp
6. IF the token refresh fails, THEN THE Auth_Manager SHALL clear all tokens and redirect to "/login"

### Requirement 15: Security Headers

**User Story:** As a security-conscious system, I want all API requests to include proper security headers, so that the application follows security best practices.

#### Acceptance Criteria

1. WHEN making requests to Backend_API, THE Auth_Manager SHALL include Content-Type header "application/json"
2. WHEN making requests to Cognito_Service token endpoint, THE Auth_Manager SHALL include Content-Type header "application/x-www-form-urlencoded"
3. THE Auth_Manager SHALL not log or expose ID_Token, Access_Token, or Refresh_Token values in console output or error messages
