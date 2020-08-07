<?php

class TwitchHelper {

	public static $accessToken;

	public static $accessTokenFile = __DIR__ . DIRECTORY_SEPARATOR . ".." . DIRECTORY_SEPARATOR . "config" . DIRECTORY_SEPARATOR . "oauth.bin";

	public static $accessTokenExpire = 60 * 60 * 24 * 60; // 60 days
	public static $accessTokenRefresh = 60 * 60 * 24 * 30; // 30 days

	public static $game_db = null;

	const LOG_ERROR = "ERROR";
	const LOG_WARNING = "WARNING";
	const LOG_INFO = "INFO";
	const LOG_DEBUG = "DEBUG";

	/**
	 * Set up directories for first use
	 *
	 * @return void
	 */
	public static function setupDirectories(){
		mkdir( __DIR__ . "/logs");
		mkdir( __DIR__ . "/payloads");
		mkdir( __DIR__ . "/public/vods");
		mkdir( __DIR__ . "/public/vods" . DIRECTORY_SEPARATOR . "clips");
		mkdir( __DIR__ . "/public/vods" . DIRECTORY_SEPARATOR . "saved");
	}

	/**
	 * Get OAuth token from Twitch. If it exists on disk, read from that instead. If it's too old then get a new one.
	 *
	 * @param boolean $force Force fetch a new token
	 * @return string Token
	 */
	public static function getAccessToken( $force = false ){

		// token should last 60 days, delete it after 30 just to be sure
		if( file_exists( self::$accessTokenFile ) ){
			$tokenRefresh = time() - filemtime( self::$accessTokenFile ) > TwitchHelper::$accessTokenRefresh;
			$tokenExpire = time() - filemtime( self::$accessTokenFile ) > TwitchHelper::$accessTokenExpire;
			if( $tokenRefresh || $tokenExpire ){
				unlink( self::$accessTokenFile );
			}
		}
		

		if( !$force && file_exists( self::$accessTokenFile ) ){
			self::log( self::LOG_DEBUG, "Fetched access token from cache");
			return file_get_contents( self::$accessTokenFile );
		}

		// oauth2
		$ch = curl_init();
		curl_setopt($ch, CURLOPT_URL, 'https://id.twitch.tv/oauth2/token?client_id=' . TwitchConfig::cfg('api_client_id') . '&client_secret=' . TwitchConfig::cfg('api_secret') . '&grant_type=client_credentials');
		curl_setopt($ch, CURLOPT_HTTPHEADER, [
			'Client-ID: ' . TwitchConfig::cfg('api_client_id')
		]);
		curl_setopt($ch, CURLOPT_POST, 1);
		curl_setopt($ch, CURLOPT_RETURNTRANSFER, TRUE);

		$server_output = curl_exec($ch);

		curl_close ($ch);

		$json = json_decode( $server_output, true );

		if(!$json['access_token']){
			self::log( TwitchHelper::LOG_ERROR, "Failed to fetch access token: " . $server_output);
			return false;
		}

		$access_token = $json['access_token'];

		self::$accessToken = $access_token;

		file_put_contents( self::$accessTokenFile, $access_token );

		self::log( TwitchHelper::LOG_INFO, "Fetched new access token");

		return $access_token;

	}
	
	/**
	 * Log a string to the current log file
	 *
	 * @param const $level
	 * @param string $text
	 * @return void
	 */
	public static function log( $level, $text ){

		if( !TwitchConfig::cfg("debug") && $level == self::LOG_DEBUG ) return;
		
		$filename 		= __DIR__ . DIRECTORY_SEPARATOR . ".." . DIRECTORY_SEPARATOR . "logs" . DIRECTORY_SEPARATOR . date("Y-m-d") . ".log";
		$filename_json 	= __DIR__ . DIRECTORY_SEPARATOR . ".." . DIRECTORY_SEPARATOR . "logs" . DIRECTORY_SEPARATOR . date("Y-m-d") . ".log.json";
		
		$log_text = file_exists( $filename ) ? file_get_contents( $filename ) : '';
		$log_json = file_exists( $filename_json ) ? json_decode( file_get_contents( $filename_json ), true ) : [];

		$date = new DateTime();

		$text_line = $date->format("Y-m-d H:i:s.v") . " | <" . $level . "> " . $text;

		$log_text .= "\n" . $text_line;

		$log_data = [
			"date" => microtime(true),
			"level" => $level,
			"text" => $text
		];

		$log_json[] = $log_data;

		file_put_contents($filename, $log_text);

		file_put_contents($filename_json, json_encode($log_json));
		
	}

	/**
	 * Get Twitch channel ID from username
	 *
	 * @param string $username
	 * @return string
	 */
	public static function getChannelId( $username ){

		$json_streamers = json_decode( file_get_contents( __DIR__ . '/../config' . DIRECTORY_SEPARATOR . 'streamers.json'), true );

		if($json_streamers[$username]){
			self::log( self::LOG_DEBUG, "Fetched channel id from cache for " . $username);	
			return $json_streamers[$username];
		}

		$access_token = self::getAccessToken();

		// webhook list
		$ch = curl_init();
		curl_setopt($ch, CURLOPT_URL, 'https://api.twitch.tv/helix/users?login=' . $username);
		curl_setopt($ch, CURLOPT_HTTPHEADER, [
		    'Authorization: Bearer ' . $access_token,
		    'Client-ID: ' . TwitchConfig::cfg('api_client_id')
		]);
		curl_setopt($ch, CURLOPT_RETURNTRANSFER, TRUE);

		$server_output = curl_exec($ch);

		curl_close ($ch);

		$json = json_decode( $server_output, true );

		if( !$json["data"] ){
			self::log(self::LOG_ERROR, "Failed to fetch channel id: " . $server_output);
			return false;
		}

		$id = $json["data"][0]["id"];
		
		$json_streamers[ $username ] = $id;
		file_put_contents( __DIR__ . '/../config' . DIRECTORY_SEPARATOR . 'streamers.json', json_encode($json_streamers) );

		self::log( self::LOG_INFO, "Fetched channel id online for " . $username);

		return $id;

	}

	/**
	 * Return videos for a streamer id
	 *
	 * @param int $streamer_id
	 * @return array|false
	 */
	public static function getVideos( $streamer_id ){

		$ch = curl_init();
		curl_setopt($ch, CURLOPT_URL, 'https://api.twitch.tv/helix/videos?user_id=' . $streamer_id);
		curl_setopt($ch, CURLOPT_HTTPHEADER, [
			'Authorization: Bearer ' . self::getAccessToken(),
		    'Client-ID: ' . TwitchConfig::cfg('api_client_id')
		]);

		curl_setopt($ch, CURLOPT_RETURNTRANSFER, TRUE);

		$server_output = curl_exec($ch);

		curl_close($ch);

		$json = json_decode( $server_output, true );

		if( !$json['data'] ){
			self::log( self::LOG_ERROR, "No videos found for user id " . $streamer_id);
			return false;
		}

		self::log( self::LOG_INFO, "Querying videos for streamer id " . $streamer_id);

		return $json['data'] ?: false;

	}

	/**
	 * Get Twitch video by video ID
	 *
	 * @param string $video_id
	 * @return array
	 */
	public static function getVideo( $video_id ){

		$ch = curl_init();
		curl_setopt($ch, CURLOPT_URL, 'https://api.twitch.tv/helix/videos?id=' . $video_id);
		curl_setopt($ch, CURLOPT_HTTPHEADER, [
			'Authorization: Bearer ' . self::getAccessToken(),
		    'Client-ID: ' . TwitchConfig::cfg('api_client_id')
		]);

		curl_setopt($ch, CURLOPT_RETURNTRANSFER, TRUE);

		$server_output = curl_exec($ch);

		curl_close($ch);

		$json = json_decode( $server_output, true );

		if( !$json['data'] ){
			self::log( self::LOG_ERROR, "No video found for video id " . $video_id);
			return null;
		}

		self::log( self::LOG_INFO, "Querying video info for id " . $video_id);

		return $json['data'][0];

	}

	/**
	 * Get game by ID from the cache
	 *
	 * @param string $id
	 * @return array
	 */
	public static function getGame( $id ){

		if( self::$game_db ){
			return self::$game_db[$id];
		}

		self::$game_db = json_decode( file_get_contents( __DIR__ . '/../config/games_v2.json' ), true );

		return self::getGame($id);

	}

	/**
	 * Parse twitch format duration: 1h1m1s
	 * Returns seconds.
	 *
	 * @param string $text Twitch duration
	 * @return int Seconds
	 */
	public static function parseTwitchDuration( $text ){

		preg_match('/([0-9]+)h/', $text, $hours_match);
		preg_match('/([0-9]+)m/', $text, $minutes_match);
		preg_match('/([0-9]+)s/', $text, $seconds_match);

		$total_seconds = 0;

		if($seconds_match[1]) $total_seconds += $seconds_match[1];
		if($minutes_match[1]) $total_seconds += $minutes_match[1] * 60;
		if($hours_match[1]) $total_seconds += $hours_match[1] * 60 * 60;

		return $total_seconds;

	}

	/**
	 * Return a human readable duration in seconds
	 * TODO: 24+ hour durations
	 *
	 * @param int $duration
	 * @return string
	 */
	public static function printHumanDuration( $duration ){

		$time = new DateTime();
		$time->setTimestamp( $duration );

		return $time->format("H:i:s");

	}

	// path helpers

	public static function is_windows(){
		return strtoupper(substr(PHP_OS, 0, 3)) === 'WIN';
	}

	public static function path_ffmpeg(){
		if( TwitchConfig::cfg('ffmpeg_path') ) return TwitchConfig::cfg('ffmpeg_path');
		if( file_exists("/usr/bin/ffmpeg") ) return "/usr/bin/ffmpeg";
		return "";
	}

	public static function path_streamlink(){
		return TwitchConfig::cfg('bin_dir') . DIRECTORY_SEPARATOR . "streamlink" . ( self::is_windows() ? '.exe' : '' );
	}

	public static function path_youtubedl(){
		return TwitchConfig::cfg('bin_dir') . DIRECTORY_SEPARATOR . "youtube-dl" . ( self::is_windows() ? '.exe' : '' );
	}

	public static function path_tcd(){
		return TwitchConfig::cfg('bin_dir') . DIRECTORY_SEPARATOR . "tcd" . ( self::is_windows() ? '.exe' : '' );
	}

	public static function path_pipenv(){
		return TwitchConfig::cfg('bin_dir') . DIRECTORY_SEPARATOR . "pipenv" . ( self::is_windows() ? '.exe' : '' );
	}

	public static function vod_folder(){
		return __DIR__ . "/../public/vods";
	}

}