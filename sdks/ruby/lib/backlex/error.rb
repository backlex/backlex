# frozen_string_literal: true

module Backlex
  # A non-2xx response from the backlex API (or a transport failure), mirroring
  # the TS SDK's BacklexError. The API returns errors as
  # `{ "error": { "code", "message", "details"? } }`; callers branch on #status /
  # #code rather than parsing strings.
  class Error < StandardError
    attr_reader :status, :code, :details

    def initialize(status, code, message, details = nil)
      super(message)
      @status = status
      @code = code
      @details = details
    end

    # Parse the `{ "error": {...} }` envelope from a response body.
    def self.from(status, body)
      code = "UNKNOWN"
      message = "HTTP #{status}"
      details = nil
      unless body.nil? || body.empty?
        begin
          env = JSON.parse(body)
          err = env["error"]
          if err.is_a?(Hash)
            code = err["code"] if err["code"]
            message = err["message"] if err["message"]
            details = err["details"]
          end
        rescue JSON::ParserError
          # non-JSON error body — keep the generic message
        end
      end
      new(status, code, message, details)
    end
  end
end
