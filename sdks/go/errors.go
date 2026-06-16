package backlex

import "fmt"

// Error is a non-2xx response from the backlex API, mirroring the TS SDK's
// BacklexError. The API returns errors as {"error": {"code","message","details"?}};
// callers branch on Status / Code instead of parsing strings.
type Error struct {
	Status  int    // HTTP status code.
	Code    string // Machine-readable code ("VALIDATION", "UNAUTHORIZED", ...); "UNKNOWN" if absent.
	Message string
	Details any // Optional structured details from the error envelope.
}

func (e *Error) Error() string {
	return fmt.Sprintf("backlex: %d %s: %s", e.Status, e.Code, e.Message)
}

// errorEnvelope is the JSON shape of an API error body.
type errorEnvelope struct {
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Details any    `json:"details"`
	} `json:"error"`
}

func newError(status int, env *errorEnvelope) *Error {
	e := &Error{Status: status, Code: "UNKNOWN", Message: fmt.Sprintf("HTTP %d", status)}
	if env != nil && env.Error != nil {
		if env.Error.Code != "" {
			e.Code = env.Error.Code
		}
		if env.Error.Message != "" {
			e.Message = env.Error.Message
		}
		e.Details = env.Error.Details
	}
	return e
}
